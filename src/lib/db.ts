/**
 * Tiny Postgres helper around Vercel Postgres.
 *
 * Only touches the two tables introduced in migrations/0001_lucas_submissions.sql:
 *   - lucas_submissions  (per-email review counter)
 *   - stripe_event_log   (webhook idempotency)
 *
 * All helpers are defensive — if DATABASE_URL is missing we return safe defaults
 * so local dev without Postgres still builds and runs. Gating logic treats a
 * missing DB as "no prior submissions", which is the right fail-open for the
 * free path and the right fail-closed for the webhook (it will no-op).
 */
import { sql } from "@vercel/postgres";

export interface LucasSubmission {
  email: string;
  first_seen: string;
  last_review_at: string | null;
  reviews_delivered: number;
  is_hh_member: boolean;
  hh_checked_at: string | null;
}

const HAS_DB = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);

function normaliseEmail(e: string): string {
  return e.trim().toLowerCase();
}

/** Returns the row for this email, or null if none exists / DB unreachable. */
export async function getSubmission(
  email: string,
): Promise<LucasSubmission | null> {
  if (!HAS_DB) return null;
  const e = normaliseEmail(email);
  try {
    const { rows } = await sql<LucasSubmission>`
      SELECT email, first_seen, last_review_at, reviews_delivered,
             COALESCE(is_hh_member, FALSE) AS is_hh_member, hh_checked_at
      FROM lucas_submissions
      WHERE email = ${e}
      LIMIT 1
    `;
    return rows[0] ?? null;
  } catch (err: any) {
    console.error("db.getSubmission failed:", err.message);
    return null;
  }
}

/**
 * Create a submissions row on first contact. Idempotent — if the row already
 * exists this is a no-op, so it's safe to call on every free submission.
 */
export async function upsertFreeSubmission(email: string): Promise<void> {
  if (!HAS_DB) return;
  const e = normaliseEmail(email);
  try {
    await sql`
      INSERT INTO lucas_submissions (email, first_seen, reviews_delivered)
      VALUES (${e}, NOW(), 0)
      ON CONFLICT (email) DO NOTHING
    `;
  } catch (err: any) {
    console.error("db.upsertFreeSubmission failed:", err.message);
  }
}

/**
 * Bump the delivered counter. Called once from /api/submissions after the n8n
 * pipeline accepts the job (free path) and once from the Stripe webhook after
 * a paid session completes.
 */
export async function incrementDelivered(email: string): Promise<void> {
  if (!HAS_DB) return;
  const e = normaliseEmail(email);
  try {
    await sql`
      INSERT INTO lucas_submissions (email, first_seen, reviews_delivered, last_review_at)
      VALUES (${e}, NOW(), 1, NOW())
      ON CONFLICT (email) DO UPDATE SET
        reviews_delivered = lucas_submissions.reviews_delivered + 1,
        last_review_at    = NOW()
    `;
  } catch (err: any) {
    console.error("db.incrementDelivered failed:", err.message);
  }
}

/**
 * Cache the Stripe customer-search result so we don't re-query on every visit.
 */
export async function cacheHhMemberFlag(
  email: string,
  isHhMember: boolean,
): Promise<void> {
  if (!HAS_DB) return;
  const e = normaliseEmail(email);
  try {
    await sql`
      UPDATE lucas_submissions
      SET is_hh_member = ${isHhMember}, hh_checked_at = NOW()
      WHERE email = ${e}
    `;
  } catch (err: any) {
    console.error("db.cacheHhMemberFlag failed:", err.message);
  }
}

/**
 * Stripe webhook idempotency — peek without recording. Use this BEFORE doing
 * any work, so a Stripe replay short-circuits early. Once the work has
 * actually succeeded, call `recordStripeEvent` to mark it processed.
 *
 * Splitting peek-then-record (vs. a single insert-and-test) means a transient
 * downstream failure (e.g. n8n down) doesn't permanently block Stripe's
 * automatic retry of the same event.
 */
export async function hasSeenStripeEvent(eventId: string): Promise<boolean> {
  if (!HAS_DB) return false;
  try {
    const { rows } = await sql<{ event_id: string }>`
      SELECT event_id FROM stripe_event_log WHERE event_id = ${eventId} LIMIT 1
    `;
    return rows.length > 0;
  } catch (err: any) {
    console.error("db.hasSeenStripeEvent failed:", err.message);
    // Fail open — if we can't check, proceed and risk a duplicate rather
    // than dropping the event entirely.
    return false;
  }
}

/**
 * Mark a Stripe event id as fully processed. Call this AFTER the downstream
 * work (n8n forward, DB updates) has succeeded.
 */
export async function recordStripeEvent(eventId: string): Promise<void> {
  if (!HAS_DB) return;
  try {
    await sql`
      INSERT INTO stripe_event_log (event_id)
      VALUES (${eventId})
      ON CONFLICT (event_id) DO NOTHING
    `;
  } catch (err: any) {
    console.error("db.recordStripeEvent failed:", err.message);
  }
}
