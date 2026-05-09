/**
 * POST /api/stripe/webhook
 *
 * Stripe sends checkout.session.completed events here. On success we forward
 * the listing job to n8n so the scrape â analysis â PDF â email pipeline runs.
 *
 * Three layers of safety on top of the original handler:
 *   - Signature verification (as before).
 *   - Idempotency via the stripe_event_log table â a Stripe replay never
 *     triggers a second PDF delivery.
 *   - After a successful n8n forward we bump `reviews_delivered` and tag the
 *     contact with `lucas-paid-review` in Mailchimp so the free-user drip
 *     (WS7) doesn't re-trigger on repeat customers.
 *
 * Configure the webhook endpoint in Stripe dashboard:
 *   URL:     https://<your-domain>/api/stripe/webhook
 *   Events:  checkout.session.completed
 */
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import crypto from "crypto";
import mailchimp from "@mailchimp/mailchimp_marketing";
import { Resend } from "resend";
import { incrementDelivered, recordStripeEvent, hasSeenStripeEvent } from "@/lib/db";

export const runtime = "nodejs"; // raw body required

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20",
});

const ENDPOINT_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const N8N_URL = process.env.N8N_BASE_URL!;
const N8N_TOKEN = process.env.N8N_WEBHOOK_TOKEN!;
const MC_API_KEY = process.env.MAILCHIMP_API_KEY;
const MC_LIST_ID = process.env.MAILCHIMP_LIST_ID;
const MC_SERVER = MC_API_KEY?.split("-").pop() || "us1";
const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (MC_API_KEY) {
  mailchimp.setConfig({ apiKey: MC_API_KEY, server: MC_SERVER });
}

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

/* ââ Hello Hosty brand palette (locked).
 *    Mirrors `/api/submissions` sendWelcomeEmail and the `hellohosty-design`
 *    skill. Keep these in sync whenever the welcome template is edited. */
const HH_CORAL = "#F44A5C";
const HH_TEAL = "#28B59D";
const HH_TEAL_SOFT = "#D8F0EB";
const HH_CREAM = "#F5F1E8";
const HH_INK = "#1A1A1A";
const HH_INK_SOFT = "#4A4A4A";
const HH_SURFACE = "#FFFFFF";
// 2026-05-09: Mark Pro and Cabinet Grotesk removed from the leading position.
// Email clients ignore inline @font-face base64 and substitute Mark Pro with a
// glyph wider than Bold, making body read heavy at font-weight:400. Match the
// production Lucas pipeline stack (Lucas Live email_templates.py): Plus Jakarta
// Sans first, then Helvetica Neue / Arial as system fallback. system-ui and
// Segoe UI also render Regular heavier than expected on Gmail web / Outlook web,
// so they are dropped too. Keep this in sync with /api/submissions/route.ts.
const HH_FONT_STACK =
  "'Plus Jakarta Sans','Helvetica Neue',Helvetica,Arial,sans-serif";

export async function POST(req: NextRequest) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new NextResponse("Missing signature", { status: 400 });

  const buf = Buffer.from(await req.arrayBuffer());
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, ENDPOINT_SECRET);
  } catch (e: any) {
    return new NextResponse(`Webhook signature failure: ${e.message}`, { status: 400 });
  }

  // Idempotency â peek first. If we've already fully processed this event,
  // ack and do nothing. We only mark the event as processed AFTER the
  // downstream work succeeds, so a previous n8n failure can retry.
  if (await hasSeenStripeEvent(event.id)) {
    console.log(`â©ï¸  Stripe webhook replay ignored: ${event.id}`);
    return NextResponse.json({ received: true, replay: true });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const md = session.metadata || {};

    // The repeat-review paywall writes listing_url + email into metadata.
    // The legacy /api/members/checkout and /api/submit paths used the same
    // keys, so this handler covers both flows.
    const email = session.customer_email || md.email || "";
    const listingUrl = md.listing_url || md.airbnb_url || "";

    // ââ Safety guard â this Stripe account also handles HelloHosty
    //    (memberships, etc.). If the same webhook endpoint somehow receives a
    //    non-Lucas event, we do NOT want to forward it to n8n. A Lucas
    //    checkout always carries listing_url (set by createPaywallCheckout or
    //    the legacy /api/submit path), so absence is the cleanest signal
    //    that this event isn't ours. Ack and no-op.
    if (!listingUrl) {
      console.log(
        `â¹ï¸  Ignoring non-Lucas checkout.session.completed (no listing_url): event=${event.id} session=${session.id}`,
      );
      await recordStripeEvent(event.id);
      return NextResponse.json({ received: true, ignored: true });
    }

    const payload = {
      url: listingUrl,
      listing_url: listingUrl,
      name: md.name || "",
      email,
      ip: md.ip || "stripe",
      paid: true,
      member_tier: md.member_tier === "true" || md.is_hh_member === "true",
      stripe_session_id: session.id,
      source: md.submission_context || "stripe-checkout",
    };

    let n8nOk = false;
    try {
      const res = await fetch(`${N8N_URL}/webhook/lucas/new-review`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lucas-token": N8N_TOKEN },
        body: JSON.stringify(payload),
      });
      n8nOk = res.ok;
    } catch (err: any) {
      console.error("n8n forward from webhook failed:", err.message);
    }

    if (!n8nOk) {
      // Return 5xx so Stripe automatically retries the webhook. We have NOT
      // recorded the event id yet, so the retry will be processed fresh.
      console.error(`ð¥ n8n forward failed for ${event.id} â returning 5xx to force Stripe retry`);
      return new NextResponse("n8n forward failed", { status: 502 });
    }

    if (email) {
      await incrementDelivered(email);
      await tagPaidReview(email).catch((e) =>
        console.error("Mailchimp paid-tag failed:", e?.message || e),
      );
    }

    // ââ Welcome / "on its way" email.
    //    Under the paid-from-start regime (commit 1b9ad68, 2026-04-30),
    //    /api/submissions short-circuits with 402 BEFORE its sendWelcomeEmail
    //    runs, so the welcome email must fire from here for paying customers.
    //    Best-effort, never blocks the Stripe ack. Listing title is best-guess
    //    via cheap scrape â falls back to "your listing" if unavailable.
    let welcomeOk = false;
    if (email) {
      try {
        const propertyTitle =
          (await fetchListingTitle(listingUrl)) || "your listing";
        welcomeOk = await sendWelcomeEmail(email, propertyTitle);
      } catch (e: any) {
        console.error("Welcome email exception:", e?.message || e);
      }
    }

    console.log(
      `ð° Stripe paid-review: email=${email} n8n=ok welcome=${welcomeOk ? "ok" : "fail"} event=${event.id}`,
    );
  }

  // All work done â mark the event processed so a replay is a no-op.
  await recordStripeEvent(event.id);
  return NextResponse.json({ received: true });
}

/**
 * Tag the contact with `lucas-paid-review`. We intentionally don't touch
 * `lucas-first-review` â the WS7 drip uses that tag to know "first free review
 * delivered", and for repeat paid customers both facts are true.
 */
async function tagPaidReview(email: string): Promise<void> {
  if (!MC_API_KEY || !MC_LIST_ID) return;
  const subscriberHash = crypto
    .createHash("md5")
    .update(email.toLowerCase())
    .digest("hex");

  // Ensure the contact exists (they may be a brand-new paid customer who
  // somehow skipped the free-review tagging â unlikely but cheap to cover).
  await mailchimp.lists.setListMember(MC_LIST_ID, subscriberHash, {
    email_address: email.toLowerCase(),
    status_if_new: "subscribed" as const,
  });

  await mailchimp.lists.updateListMemberTags(MC_LIST_ID, subscriberHash, {
    tags: [{ name: "lucas-paid-review", status: "active" }],
  });
}

/* ââ Listing-title scrape (best-effort, ~10s budget).
 *    Mirrors fetchListingTitle in /api/submissions. We do NOT want to block
 *    the Stripe ack on n8n latency, so the timeout is tight and we fall back
 *    cleanly. If the title is missing, the welcome email reads "your listing"
 *    rather than the property name. */
async function fetchListingTitle(url: string): Promise<string | null> {
  if (!N8N_URL || !N8N_TOKEN || !url) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
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
    console.warn("Title scrape failed:", err?.message || err);
    return null;
  }
}

/* ââ Welcome email via Resend.
 *    Mirrors sendWelcomeEmail in /api/submissions/route.ts. If the template
 *    there changes, change this one too. Subject pattern is the load-bearing
 *    string the dashboard uses to classify the message as a confirmation. */
async function sendWelcomeEmail(
  toEmail: string,
  propertyTitle: string,
): Promise<boolean> {
  if (!resend) {
    console.warn("Resend not configured â skipping welcome email");
    return false;
  }
  const safeTitle = escapeHtml(propertyTitle);
  const html = `
    <!doctype html>
    <html lang="en-GB">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width">
        <title>Your Lucas review is on its way</title>
      </head>
      <body style="margin:0;padding:0;background:${HH_CREAM};font-family:${HH_FONT_STACK};color:${HH_INK};">
        <span style="display:none !important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">Your Lucas review of ${safeTitle} is being built now. Two to four minutes, then it lands here.</span>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${HH_CREAM};padding:32px 16px;">
          <tr><td align="center">
            <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:${HH_SURFACE};border-radius:16px;overflow:hidden;max-width:600px;box-shadow:0 6px 24px -8px rgba(26,26,26,0.08);">
              <tr><td style="padding:28px 32px 0 32px;font-weight:400;">
                <span style="font-family:${HH_FONT_STACK};font-size:22px;font-weight:700;color:${HH_INK};letter-spacing:-0.01em;">Hello Hosty</span>
                <span style="display:inline-block;margin-left:10px;padding:4px 10px;background:${HH_TEAL_SOFT};color:${HH_TEAL};border-radius:999px;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;vertical-align:2px;">Lucas</span>
              </td></tr>
              <tr><td style="padding:24px 32px 8px 32px;font-family:${HH_FONT_STACK};font-size:16px;line-height:1.6;color:${HH_INK};font-weight:400;">
                <h1 style="margin:0 0 16px;font-family:${HH_FONT_STACK};font-size:28px;line-height:1.15;font-weight:700;color:${HH_INK};letter-spacing:-0.01em;">Your review is on its way.</h1>
                <p style="margin:0 0 16px;font-weight:400;">Hi there,</p>
                <p style="margin:0 0 16px;font-weight:400;">Thanks for trusting Lucas with your listing. We're reading ${safeTitle} now, scoring it against the patterns that move the needle on Airbnb, and writing optimised copy you can paste straight back in.</p>
                <p style="margin:0 0 16px;font-weight:400;">The full PDF report will land in this inbox in the next two to four minutes.</p>
              </td></tr>
              <tr><td style="padding:8px 32px 8px 32px;font-family:${HH_FONT_STACK};font-size:14px;line-height:1.6;color:${HH_INK_SOFT};font-weight:400;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${HH_TEAL_SOFT};border-radius:12px;">
                  <tr><td style="padding:14px 18px;font-family:${HH_FONT_STACK};font-size:14px;line-height:1.55;color:${HH_INK};font-weight:400;">
                    <span style="color:${HH_TEAL};font-weight:600;">&check;</span> &nbsp;If it doesn't land, check your spam folder, then add <a href="mailto:lucas@hellohosty.com" style="color:${HH_TEAL};text-decoration:underline;font-weight:400;">lucas@hellohosty.com</a> to your contacts so the next ones come through cleanly.
                  </td></tr>
                </table>
              </td></tr>
              <tr><td style="padding:24px 32px 32px 32px;font-family:${HH_FONT_STACK};font-size:16px;line-height:1.6;color:${HH_INK};font-weight:400;">
                <p style="margin:0 0 16px;font-weight:400;">Talk in a few minutes,</p>
                <p style="margin:0;font-weight:400;">Lucas<br><span style="color:${HH_INK_SOFT};font-size:13px;">AI listing review at Hello Hosty</span></p>
              </td></tr>
              <tr><td style="background:${HH_CREAM};padding:20px 32px;font-family:${HH_FONT_STACK};font-size:12px;color:${HH_INK_SOFT};text-align:center;font-weight:400;">
                You're receiving this because you ordered an AI listing review at lucas.hellohosty.com.<br>
                Hello Hosty &middot; <a href="mailto:lucas@hellohosty.com" style="color:${HH_INK_SOFT};">lucas@hellohosty.com</a> &middot; <a href="https://hellohosty.com" style="color:${HH_INK_SOFT};">hellohosty.com</a>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body>
    </html>
  `;
  const text =
    `Hi there,\n\n` +
    `Thanks for trusting Lucas with your listing. We're reading ${propertyTitle} now, scoring it against the patterns that move the needle on Airbnb, and writing optimised copy you can paste straight back in.\n\n` +
    `The full PDF report will land in this inbox in the next two to four minutes.\n\n` +
    `If it doesn't land, check your spam folder, then add lucas@hellohosty.com to your contacts so the next ones come through cleanly.\n\n` +
    `Talk in a few minutes,\n\n` +
    `Lucas\n` +
    `AI listing review at Hello Hosty\n`;

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
    console.error("Resend welcome email exception:", err?.message || err);
    return false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
