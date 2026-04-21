/**
 * POST /api/stripe/webhook
 *
 * Stripe sends checkout.session.completed events here. On success we forward
 * the listing job to n8n so the scrape → analysis → PDF → email pipeline runs.
 *
 * Three layers of safety on top of the original handler:
 *   - Signature verification (as before).
 *   - Idempotency via the stripe_event_log table — a Stripe replay never
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

if (MC_API_KEY) {
  mailchimp.setConfig({ apiKey: MC_API_KEY, server: MC_SERVER });
}

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

  // Idempotency — peek first. If we've already fully processed this event,
  // ack and do nothing. We only mark the event as processed AFTER the
  // downstream work succeeds, so a previous n8n failure can retry.
  if (await hasSeenStripeEvent(event.id)) {
    console.log(`↩️  Stripe webhook replay ignored: ${event.id}`);
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

    // ── Safety guard — this Stripe account also handles HelloHosty
    //    (memberships, etc.). If the same webhook endpoint somehow receives a
    //    non-Lucas event, we do NOT want to forward it to n8n. A Lucas
    //    checkout always carries listing_url (set by createPaywallCheckout or
    //    the legacy /api/submit path), so absence is the cleanest signal
    //    that this event isn't ours. Ack and no-op.
    if (!listingUrl) {
      console.log(
        `ℹ️  Ignoring non-Lucas checkout.session.completed (no listing_url): event=${event.id} session=${session.id}`,
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
      console.error(`💥 n8n forward failed for ${event.id} — returning 5xx to force Stripe retry`);
      return new NextResponse("n8n forward failed", { status: 502 });
    }

    if (email) {
      await incrementDelivered(email);
      await tagPaidReview(email).catch((e) =>
        console.error("Mailchimp paid-tag failed:", e?.message || e),
      );
    }

    console.log(
      `💰 Stripe paid-review: email=${email} n8n=ok event=${event.id}`,
    );
  }

  // All work done — mark the event processed so a replay is a no-op.
  await recordStripeEvent(event.id);
  return NextResponse.json({ received: true });
}

/**
 * Tag the contact with `lucas-paid-review`. We intentionally don't touch
 * `lucas-first-review` — the WS7 drip uses that tag to know "first free review
 * delivered", and for repeat paid customers both facts are true.
 */
async function tagPaidReview(email: string): Promise<void> {
  if (!MC_API_KEY || !MC_LIST_ID) return;
  const subscriberHash = crypto
    .createHash("md5")
    .update(email.toLowerCase())
    .digest("hex");

  // Ensure the contact exists (they may be a brand-new paid customer who
  // somehow skipped the free-review tagging — unlikely but cheap to cover).
  await mailchimp.lists.setListMember(MC_LIST_ID, subscriberHash, {
    email_address: email.toLowerCase(),
    status_if_new: "subscribed" as const,
  });

  await mailchimp.lists.updateListMemberTags(MC_LIST_ID, subscriberHash, {
    tags: [{ name: "lucas-paid-review", status: "active" }],
  });
}
