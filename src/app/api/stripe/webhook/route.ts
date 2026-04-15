/**
 * POST /api/stripe/webhook
 *
 * Stripe sends checkout.session.completed events here. On success we forward
 * the listing job to n8n so the scrape → analysis → PDF → email pipeline runs.
 *
 * Configure the webhook endpoint in Stripe dashboard:
 *   URL:     https://<your-domain>/api/stripe/webhook
 *   Events:  checkout.session.completed
 */
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";

export const runtime = "nodejs"; // raw body required

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20",
});

const ENDPOINT_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
const N8N_URL = process.env.N8N_BASE_URL!;
const N8N_TOKEN = process.env.N8N_WEBHOOK_TOKEN!;

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

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const md = session.metadata || {};
    const payload = {
      url: md.listing_url,
      name: md.name,
      email: session.customer_email || md.email,
      ip: md.ip || "stripe",
      paid: true,
      member_tier: md.member_tier === "true",
      stripe_session_id: session.id,
    };
    await fetch(`${N8N_URL}/webhook/lucas/new-review`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lucas-token": N8N_TOKEN },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }

  return NextResponse.json({ received: true });
}
