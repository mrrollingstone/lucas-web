/**
 * POST /api/submissions
 *
 * Accepts the full session payload from the landing funnel after step 3.
 *
 * Step 0 (new): repeat-review gate.
 *    Before any compute, look the email up in `lucas_submissions`. If the
 *    caller has already had their free review we short-circuit with 402 and a
 *    Stripe Checkout URL instead of kicking off another scrape + analysis.
 *
 * Then, for first-time callers:
 * 1. Scrapes the Airbnb listing title (so the welcome email reads naturally)
 * 2. Sends an immediate "Hey there, thanks for trying Lucas" email via Resend
 *    using the scraped property title — replaces the previous n8n lucas-drip
 *    webhook which sent the same email but with the raw URL embedded.
 * 3. Forwards to n8n webhook (which kicks off the report-generation pipeline)
 * 4. Tags the email in Mailchimp with `lucas-first-review` (drives the 24h+ drip)
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

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";

  /* ── 0. Repeat-review gate — MUST run before any compute/cost ──
   *    If this email has already been delivered a review, we refuse to
   *    generate another free one. Instead we mint a Stripe Checkout URL and
   *    hand it back with 402 Payment Required so the frontend can redirect.
   */
  const existing = await getSubmission(body.email);
  if (existing && existing.reviews_delivered >= 1) {
    // Member lookup (cached on the row for 7 days).
    const isHhMember = await lookupHhMember(body.email);
    const checkoutUrl = await createPaywallCheckout({
      email: body.email,
      airbnbUrl: body.listing_url,
      isHhMember,
    });
    console.log(
      `💳 Repeat review — paywall: email=${body.email} hh_member=${isHhMember} delivered=${existing.reviews_delivered}`,
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

  /* ── 0b. First-time caller — record the row now so lookupHhMember can
   *       cache against it. Idempotent; safe to call repeatedly. */
  await upsertFreeSubmission(body.email);

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
                You're receiving this because you requested a free AI listing review at lucas.hellohosty.com.<br>
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

/* ── Tiny HTML escape (avoid pulling a whole helper lib for one use) ── */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
