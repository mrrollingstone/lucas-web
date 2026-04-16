/**
 * POST /api/submit
 *
 * The public landing page posts {url, name, email, member_tier} here.
 * Responsibilities:
 *   1. Basic validation + rate-limit keys (IP + email).
 *   2. First-time check — call out to n8n's /lucas/first-time webhook which
 *      cross-references Mailchimp + Stripe to decide free vs paid.
 *   3. If first-time (or member_tier override allows the free slot), forward
 *      the job to n8n's /lucas/new-review webhook and return {next: "email"}.
 *   4. If repeat, create a Stripe Checkout session and return {next: "stripe"}.
 */
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { z } from "zod";

const SubmitSchema = z.object({
  url: z.string().url().regex(/airbnb\.[a-z.]+\/rooms\/\d+/i, "Not an Airbnb URL"),
  name: z.string().min(1).max(120),
  email: z.string().email().toLowerCase(),
  member_tier: z.boolean().optional().default(false),
});

const N8N_URL = process.env.N8N_BASE_URL!;           // e.g. https://n8n.hellohosty.com
const N8N_TOKEN = process.env.N8N_WEBHOOK_TOKEN!;    // shared secret header

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20",
});

export async function POST(req: NextRequest) {
  let body: z.infer<typeof SubmitSchema>;
  try {
    body = SubmitSchema.parse(await req.json());
  } catch (e: any) {
    return NextResponse.json({ error: "Invalid input", detail: e.errors ?? String(e) }, { status: 400 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
          || req.headers.get("x-real-ip")
          || "unknown";

  // Step 1 — Ask n8n whether this (email, ip) pair has used Lucas before.
  const firstTime = await checkFirstTime(body.email, ip);

  if (firstTime) {
    // Free path — forward to the review-start webhook and return.
    const ok = await triggerReview({
      ...body, ip, paid: false, member_tier: body.member_tier ?? false,
    });
    if (!ok) return NextResponse.json({ error: "Upstream unavailable" }, { status: 502 });
    return NextResponse.json({ next: "email" });
  }

  // Repeat — create a Stripe Checkout session.
  // Single multi-currency Price: Stripe auto-picks GBP/USD/EUR from the
  // buyer's locale. Member discount (if any) is applied via a coupon, not a
  // separate price — TODO: add STRIPE_MEMBER_COUPON env var when ready.
  const priceId = process.env.STRIPE_PRICE_ID!;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: body.email,
    metadata: {
      listing_url: body.url,
      name: body.name,
      ip,
      member_tier: String(body.member_tier),
    },
    success_url:
      `${process.env.PUBLIC_BASE_URL}/buy/confirmation?email=${encodeURIComponent(body.email)}`,
    cancel_url: `${process.env.PUBLIC_BASE_URL}${body.member_tier ? "/buy/member" : "/buy"}`,
  });

  return NextResponse.json({ next: "stripe", checkout_url: session.url });
}


async function checkFirstTime(email: string, ip: string): Promise<boolean> {
  try {
    const res = await fetch(`${N8N_URL}/webhook/lucas/first-time`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lucas-token": N8N_TOKEN },
      body: JSON.stringify({ email, ip }),
      cache: "no-store",
    });
    if (!res.ok) return false; // Safe default: paid path if we can't verify.
    const data = await res.json();
    return Boolean(data.first_time);
  } catch {
    return false;
  }
}

async function triggerReview(payload: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`${N8N_URL}/webhook/lucas/new-review`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lucas-token": N8N_TOKEN },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}
