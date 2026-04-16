/**
 * POST /api/members/checkout
 *
 * Creates a Stripe Checkout session for repeat member reviews with 30% off.
 * Called when a logged-in HH member submits a second (or subsequent) review.
 *
 * Env vars: STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_MEMBER_COUPON,
 *           PUBLIC_BASE_URL
 */
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { cookies } from "next/headers";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20",
});

export async function POST(req: NextRequest) {
  let body: {
    email: string;
    listing_url: string;
    host_name?: string;
    member_id?: string;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.email || !body.listing_url) {
    return NextResponse.json({ error: "Missing email or listing_url" }, { status: 400 });
  }

  const priceId = process.env.STRIPE_PRICE_ID!;
  const memberCoupon = process.env.STRIPE_MEMBER_COUPON; // 30% off coupon ID

  try {
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: body.email,
      metadata: {
        listing_url: body.listing_url,
        name: body.host_name || "",
        member_id: body.member_id || "",
        member_tier: "true",
        source: "members-review",
      },
      success_url: `${process.env.PUBLIC_BASE_URL}/buy/confirmation?email=${encodeURIComponent(body.email)}`,
      cancel_url: `${process.env.PUBLIC_BASE_URL}/members/review`,
    };

    // Apply 30% member discount if coupon is configured
    if (memberCoupon) {
      sessionParams.discounts = [{ coupon: memberCoupon }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return NextResponse.json({ checkout_url: session.url });
  } catch (err: any) {
    console.error("Stripe checkout creation failed:", err.message);
    return NextResponse.json({ error: "Failed to create checkout" }, { status: 500 });
  }
}
