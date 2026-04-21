/**
 * HH-member lookup.
 *
 * A submitter is considered a Hello Hosty member if Stripe has a Customer
 * record with their email — HH subscriptions are billed through the same
 * Stripe account, so customer presence is a reliable signal.
 *
 * Result is cached on the lucas_submissions row (`is_hh_member`, `hh_checked_at`)
 * so we don't hammer Stripe on every repeat visit.
 */
import Stripe from "stripe";
import { cacheHhMemberFlag, getSubmission } from "./db";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-06-20",
});

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Returns true if the email matches an existing Stripe Customer. Uses the
 * cached flag on lucas_submissions when it's fresh; otherwise queries Stripe
 * and updates the cache.
 */
export async function lookupHhMember(email: string): Promise<boolean> {
  // 1. Try the cached value first.
  const row = await getSubmission(email);
  if (row?.hh_checked_at) {
    const age = Date.now() - new Date(row.hh_checked_at).getTime();
    if (age < CACHE_TTL_MS) {
      return row.is_hh_member;
    }
  }

  // 2. Miss — ask Stripe. Customer search supports an `email:` filter.
  if (!process.env.STRIPE_SECRET_KEY) return false;
  try {
    const res = await stripe.customers.search({
      query: `email:"${email.toLowerCase().replace(/"/g, '\\"')}"`,
      limit: 1,
    });
    const isMember = res.data.length > 0;
    // 3. Cache if we already have a submissions row (we do when called from
    //    /api/submissions after upsertFreeSubmission). Fire-and-forget.
    if (row) {
      cacheHhMemberFlag(email, isMember).catch(() => {});
    }
    return isMember;
  } catch (err: any) {
    console.error("lookupHhMember: stripe.customers.search failed:", err.message);
    return false;
  }
}
