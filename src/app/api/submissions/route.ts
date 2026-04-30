/**
 * POST /api/submissions
 *
 * Accepts the full session payload from the landing funnel after step 3.
 *
 * Step 0 (paywall-from-start gate):
 *    Before any compute, look the email up in `lucas_submissions`. If there
 *    is no row at all, OR the caller has already received a review, we
 *    short-circuit with 402 and a Stripe Checkout URL — every review is paid.
 *
 *    Grandfather exception: emails that were captured under the previous
 *    free-first-review regime are honoured. There are two cohorts:
 *      (a) anyone with an existing row in `lucas_submissions` and
 *          reviews_delivered == 0  (they started the funnel, didn't finish);
 *      (b) anyone tagged `listing-review-later` in Mailchimp (they left an
 *          email via the "finish later" modal but never came back). For (b)
 *          we do a one-shot Mailchimp tag lookup and, if matched, create the
 *          DB row and let them through. After that single free run they're
 *          counted as a normal paid customer.
 *
 * For first-time (paid) callers the 402 carries the Stripe Checkout URL.
 * For grandfathered callers the rest of the pipeline runs as before:
 * 1. Scrapes the Airbnb listing title (so the welcome email reads naturally)
 * 2. Sends an immediate "Hey there, thanks for trying Lucas" email via Resend
 *    using the scraped property title.
 * 3. Forwards to n8n webhook (which kicks off the report-generation pipeline)
 * 4. Tags the email in Mailchimp with `lucas-first-review` (drives the drip)
 * 5. Increments `reviews_delivered` on the submissions row. We count on n8n
 *    accept rather than a downstream delivery callback — pragmatic given we
 *    don't currently get a "PDF sent" signal back from n8n.
 *
 * Env vars required:
 *   RESEND_API_KEY         — for the welcome email
 *   N8N_BASE_URL, N8N_WEBHOOK_TOKEN
 *   MAILCHIMP_API_KEY, MAILCHIMP_LIST_ID
 *   DATABASE_URL           — Vercel Postgres (for the repeat-review gate)
 *   STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_MEMBER_COUPON (optional)
 */
import { NextRequest, NextResponse } from "next/server";
import mailchimp from "@mailchimp/mailchimp_marketing";
import { Resend } from "resend";
import crypto from "crypto";
import {
  getSubmission,
  upsertFreeSubmission,
  incrementDelivered,
} from "@/lib/db";
import { lookupHhMember } from "@/lib/hh-member";
import { createPaywallCheckout } from "@/lib/stripe-checkout";

/* ── Env ── */
const N8N_URL = process.env.N8N_BASE_URL;
const N8N_TOKEN = process.env.N8N_WEBHOOK_TOKEN;
const MC_API_KEY = process.env.MAILCHIMP_API_KEY;
const MC_LIST_ID = process.env.MAILCHIMP_LIST_ID;
const MC_SERVER = MC_API_KEY?.split("-").pop() || "us1";
const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (MC_API_KEY) {
  mailchimp.setConfig({ apiKey: MC_API_KEY, server: MC_SERVER });
}

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

/* ── Brand colours (mirrors tailwind.config + email_templates.py) ── */
const BRAND_TEAL = "#2BB5B2";
const BRAND_INK = "#1F2933";

/* ── Payload shape from the frontend ── */
interface SubmissionPayload {
  email: string;
  // Most fields are optional so the summit-campaign path (which only carries
  // email + listing_url + platform) can reuse this endpoint without bloating
  // the payload with `undefined`s.
  host_name?: string;
  property_name?: string;
  listing_url: string;
  platform: string;
  superhost?: boolean;
  reviews_count?: number;
  avg_rating?: number;
  booking_url?: string;
  vrbo_url?: string;
  website_url?: string;
  is_first_time: boolean;
  submitted_at: string;
  scraped_at?: string | null;
  // Set to "summit" when the visitor arrived from the Short Stay Summit
  // Meta Instant Form (see the bridge email in Mailchimp).
  utm_source?: string;
}

/* ── Input validation ──
 * Reject syntactically broken submissions before any compute (scrape +
 * Claude analysis + PDF render + Cloudinary upload is ~2 minutes per run).
 * Without this guard, junk values like "_removed_" pass the previous
 * presence-only check, the pipeline runs, then SMTP rejects the recipient
 * and we've burned compute on nothing.
 *
 * Email: standard "local@domain.tld" shape. Not full RFC 5322 (which is
 * famously hard to express as a regex), but tight enough to reject any
 * string without an @ and a dot in the domain part.
 *
 * Airbnb URL: matches the canonical /rooms/<digits> path that the scraper
 * needs. Anything else (raw airbnb.com root, /experiences/, malformed)
 * gets bounced with 400.
 */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const AIRBNB_RE = /airbnb\.[a-z.]+\/(?:rooms|h)\/[A-Za-z0-9-]+/i;

export async function POST(req: NextRequest) {
  let body: SubmissionPayload;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.email || !body.listing_url) {
    return NextResponse.json(
      { error: "Missing required fields (email, listing_url)" },
      { status: 400 },
    );
  }
  if (!EMAIL_RE.test(body.email)) {
    return NextResponse.json(
      { error: "Invalid email address" },
      { status: 400 },
    );
  }
  if (!AIRBNB_RE.test(body.listing_url)) {
    return NextResponse.json(
      { error: "Invalid Airbnb listing URL. Expected airbnb.com/rooms/<id>." },
      { status: 400 },
    );
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";

  /* ── 0. Paywall-from-start gate — MUST run before any compute/cost ──
   *    Every review is paid. Two grandfather cohorts get a single free run:
   *      (a) emails with an existing row + reviews_delivered == 0 (started
   *          funnel under the old regime, haven't received yet)
   *      (b) emails currently tagged `listing-review-later` in Mailchimp
   *          (left email via "finish later" modal under the old regime).
   *    Anyone else: 402 + Stripe Checkout URL. */
  const existing = await getSubmission(body.email);

  let isGrandfathered = false;
  if (!existing) {
    // No DB row — check if they're in the legacy chase-up Mailchimp audience.
    isGrandfathered = await isLegacyChaseUpLead(body.email);
  } else if (existing.reviews_delivered === 0) {
    // Started funnel under the old regime; let the old promise stand.
    isGrandfathered = true;
  }

  const needsPayment = !isGrandfathered &&
    (!existing || existing.reviews_delivered >= 1);

  if (needsPayment) {
    // Member lookup (cached on the row for 7 days).
    const isHhMember = await lookupHhMember(body.email);
    const checkoutUrl = await createPaywallCheckout({
      email: body.email,
      airbnbUrl: body.listing_url,
      isHhMember,
    });
    console.log(
      `💳 Paywall: email=${body.email} hh_member=${isHhMember} delivered=${existing?.reviews_delivered ?? 0} new_email=${!existing}`,
    );
    return NextResponse.json(
      {
        needs_payment: true,
        is_hh_member: isHhMember,
        email: body.email,
        checkout_url: checkoutUrl,
      },
      { status: 402 },
    );
  }

  /* ── 0b. Grandfathered caller — record the row now so lookupHhMember can
   *       cache against it. Idempotent; safe to call repeatedly. */
  await upsertFreeSubmission(body.email);
  if (!existing) {
    console.log(
      `🎟  Grandfathered legacy chase-up lead: email=${body.email}`,
    );
  }

  /* ── 1. Scrape the listing title (best-effort, ~10s budget) ── */
  const propertyTitle =
    body.property_name?.trim() ||
    (await fetchListingTitle(body.listing_url)) ||
    "your listing";

  /* ── 2. Send the immediate welcome email (uses the scraped title) ── */
  const welcomeOk = await sendWelcomeEmail(body.email, propertyTitle);

  /* ── 3. Forward to n8n — kicks off the report-generation pipeline ── */
  const n8nOk = await forwardToN8n({ ...body, ip });

  /* ── 4. Tag in Mailchimp — dual-tag summit-campaign leads ── */
  const isSummit = body.utm_source === "summit";
  const mcOk = await tagInMailchimp(body.email, body.host_name || "", isSummit);

  /* ── 5. Count the delivered review iff n8n accepted the job. We do NOT
   *       bump the counter if n8n is unreachable — that's exactly the case
   *       where the user hasn't actually had their free one. */
  if (n8nOk) {
    await incrementDelivered(body.email);
  }

  console.log(
    `📋 Submission: email=${body.email} listing=${body.listing_url} title="${propertyTitle}" welcome=${welcomeOk ? "ok" : "fail"} n8n=${n8nOk ? "ok" : "fail"} mc=${mcOk ? "ok" : "fail"}${isSummit ? " [summit]" : ""}`,
  );

  return NextResponse.json({
    ok: true,
    welcome: welcomeOk ? "sent" : "unavailable",
    n8n: n8nOk ? "forwarded" : "unavailable",
    mailchimp: mcOk ? "tagged" : "unavailable",
    title: propertyTitle,
  });
}

/* ── Title scrape: ask the existing n8n scraper for the listing title.
 *    Falls back to the URL host if the scraper is slow or unreachable. ── */
async function fetchListingTitle(url: string): Promise<string | null> {
  if (!N8N_URL || !N8N_TOKEN) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000); // 10s budget — keep submission snappy
    const res = await fetch(`${N8N_URL}/webhook/lucas/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-lucas-token": N8N_TOKEN,
      },
      body: JSON.stringify({ url, platform: "airbnb", title_only: true }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data: any = await res.json().catch(() => ({}));
    const title: string | undefined =
      data?.content?.title || data?.property?.name || data?.title;
    if (title && typeof title === "string" && title.trim().length > 0) {
      return title.trim();
    }
    return null;
  } catch (err: any) {
    console.warn("Title scrape failed:", err.message);
    return null;
  }
}

/* ── Welcome email via Resend ── */
async function sendWelcomeEmail(
  toEmail: string,
  propertyTitle: string,
): Promise<boolean> {
  if (!resend) {
    console.warn("Resend not configured — skipping welcome email");
    return false;
  }
  const safeTitle = escapeHtml(propertyTitle);
  const html = `
    <!doctype html>
    <html lang="en-GB">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width">
        <title>Thanks for trying Lucas</title>
      </head>
      <body style="margin:0;padding:0;background:#F2F2F2;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${BRAND_INK};">
        <span style="display:none !important;opacity:0;color:transparent;height:0;width:0;">Your AI listing review is being generated now — usually 2-4 minutes.</span>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F2F2;padding:32px 0;">
          <tr><td align="center">
            <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:560px;">
              <tr><td style="background:${BRAND_TEAL};padding:18px 28px;color:#ffffff;font-weight:700;font-size:14px;letter-spacing:0.5px;">
                HELLOHOSTY · AI LISTING REVIEW
              </td></tr>
              <tr><td style="padding:28px;font-size:15px;line-height:1.55;">
                <p style="margin:0 0 14px;color:${BRAND_TEAL};font-weight:600;">Hey there,</p>
                <p style="margin:0 0 14px;">Thanks for trying Lucas, your AI listing review for <strong>${safeTitle}</strong>.</p>
                <p style="margin:0 0 14px;">Our AI is analysing your listing right now — scoring it against best practice, finding the quick wins, and writing optimised copy you can paste straight back into Airbnb.</p>
                <p style="margin:0 0 14px;">Your full PDF report will land in this inbox within the next few minutes. If it doesn't show up, check your spam folder and add <a href="mailto:lucas@hellohosty.com" style="color:${BRAND_TEAL};">lucas@hellohosty.com</a> to your contacts so the next ones come through cleanly.</p>
                <p style="margin:18px 0 0;">— The HelloHosty team</p>
              </td></tr>
              <tr><td style="background:#F8FAFA;padding:18px 28px;font-size:12px;color:#667085;text-align:center;">
                You're receiving this because you requested a Lucas listing review at lucas.hellohosty.com.<br>
                HelloHosty · <a href="mailto:lucas@hellohosty.com" style="color:#667085;">lucas@hellohosty.com</a> · <a href="https://hellohosty.com" style="color:#667085;">hellohosty.com</a>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body>
    </html>
  `;

  const text =
    `Hey there,\n\n` +
    `Thanks for trying Lucas, your AI listing review for ${propertyTitle}.\n\n` +
    `Our AI is analysing your listing right now — scoring it against best practice, ` +
    `finding the quick wins, and writing optimised copy you can paste straight back into Airbnb.\n\n` +
    `Your full PDF report will land in this inbox within the next few minutes. ` +
    `If it doesn't show up, check your spam folder and add lucas@hellohosty.com to your contacts.\n\n` +
    `— The HelloHosty team\n`;

  try {
    const { error } = await resend.emails.send({
      from: "Lucas at HelloHosty <lucas@notify.hellohosty.com>",
      to: [toEmail],
      replyTo: "lucas@hellohosty.com",
      subject: `Your Lucas review of ${propertyTitle} is on its way`,
      html,
      text,
      headers: { "X-Entity-Ref-ID": `lucas-welcome-${Date.now()}` },
    });
    if (error) {
      console.error("Resend welcome email failed:", error);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error("Resend welcome email exception:", err.message);
    return false;
  }
}

/* ── n8n forwarding (report pipeline) ── */
async function forwardToN8n(
  payload: SubmissionPayload & { ip: string },
): Promise<boolean> {
  if (!N8N_URL || !N8N_TOKEN) {
    console.warn("n8n not configured — skipping submission forward");
    return false;
  }
  try {
    const res = await fetch(`${N8N_URL}/webhook/lucas/new-review`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-lucas-token": N8N_TOKEN,
      },
      body: JSON.stringify({
        ...payload,
        paid: false, // Free-first-review funnel
        source: "landing-funnel-v2",
      }),
      cache: "no-store",
    });
    return res.ok;
  } catch (err: any) {
    console.error("n8n forward failed:", err.message);
    return false;
  }
}

/* ── Mailchimp: upsert contact + apply tag(s).
 *    Summit-campaign leads get both `lucas-first-review` and `summit-2026` so
 *    they land in the correct downstream drip path. ── */
async function tagInMailchimp(
  email: string,
  firstName: string,
  isSummit: boolean = false,
): Promise<boolean> {
  if (!MC_API_KEY || !MC_LIST_ID) {
    console.warn("Mailchimp not configured — skipping tag");
    return false;
  }

  const subscriberHash = crypto
    .createHash("md5")
    .update(email.toLowerCase())
    .digest("hex");

  try {
    await mailchimp.lists.setListMember(MC_LIST_ID, subscriberHash, {
      email_address: email.toLowerCase(),
      status_if_new: "subscribed" as const,
      merge_fields: {
        FNAME: firstName || "",
      },
    });

    const tags: Array<{ name: string; status: "active" | "inactive" }> = [
      { name: "lucas-first-review", status: "active" },
    ];
    if (isSummit) {
      tags.push({ name: "summit-2026", status: "active" });
    }

    await mailchimp.lists.updateListMemberTags(MC_LIST_ID, subscriberHash, {
      tags,
    });

    return true;
  } catch (err: any) {
    console.error(
      "Mailchimp tagging failed:",
      err.response?.body?.detail || err.message,
    );
    return false;
  }
}

/* ── Mailchimp grandfather check ──
 * When a brand-new email hits the gate (no DB row yet), we still want to
 * honour anyone in the legacy `listing-review-later` audience — those people
 * left their email via the "finish later" modal under the old free-first
 * regime and we promised them a free first review. One Mailchimp tag lookup;
 * fail-closed (treat as not-grandfathered) so a Mailchimp outage doesn't open
 * the paywall to everyone.
 *
 * NEW chase-up signups going forward use the `lucas-paywall-later` tag (see
 * /api/later-link), so this check only matches the legacy cohort. */
async function isLegacyChaseUpLead(email: string): Promise<boolean> {
  if (!MC_API_KEY || !MC_LIST_ID) return false;
  const subscriberHash = crypto
    .createHash("md5")
    .update(email.toLowerCase())
    .digest("hex");
  try {
    const tagsRes = (await mailchimp.lists.getListMemberTags(
      MC_LIST_ID,
      subscriberHash,
    )) as { tags?: Array<{ name: string }> };
    const tags = tagsRes?.tags ?? [];
    return tags.some((t) => t.name === "listing-review-later");
  } catch (err: any) {
    // 404 = contact doesn't exist in Mailchimp — definitely not legacy.
    if (err?.status === 404 || err?.response?.status === 404) return false;
    console.warn(
      "Mailchimp grandfather lookup failed (treating as not legacy):",
      err.response?.body?.detail || err.message,
    );
    return false;
  }
}

/* ── Tiny HTML escape (avoid pulling a whole helper lib for one use) ── */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
