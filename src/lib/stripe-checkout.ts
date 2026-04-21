/**
 * Stripe Checkout session builder for the repeat-review paywall.
 *
 * Standard price    : STRIPE_PRICE_ID (£14 one-off)
 * Member discount   : STRIPE_MEMBER_COUPON (30% off; apply only when the
 *                     submitter is a confirmed HH member)
 *
 * client_reference_id carries the email so the webhook can resume the right
 * review, and `metadata.airbnb_url` is how we remember which listing to scrape
 * after payment.
 */
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2024-06-20",
});

export interface PaywallCheckoutInput {
  email: string;
  airbnbUrl: string;
  isHhMember: boolean;
}

/**
 * Create a Checkout session for a repeat review and return its hosted URL.
 * Returns null if Stripe isn't configured (local dev without keys).
 */
export async function createPaywallCheckout(
  input: PaywallCheckoutInput,
): Promise<string | null> {
  const priceId = process.env.STRIPE_PRICE_ID;
  const memberCoupon = process.env.STRIPE_MEMBER_COUPON;
  const baseUrl = process.env.PUBLIC_BASE_URL || "https://lucas.hellohosty.com";

  if (!process.env.STRIPE_SECRET_KEY || !priceId) {
    console.warn("createPaywallCheckout: Stripe not configured");
    return null;
  }

  try {
    // Stripe templates {CHECKOUT_SESSION_ID} into the success URL, but everything
    // else we want is known at session-creation time — so we embed the email
    // directly and let /buy/confirmation render the "on its way" screen. The
    // webhook is the source of truth for kicking off the pipeline.
    const successUrl =
      `${baseUrl}/buy/confirmation` +
      `?email=${encodeURIComponent(input.email)}` +
      `&paid=1&session_id={CHECKOUT_SESSION_ID}`;

    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: input.email,
      client_reference_id: input.email,
      metadata: {
        // These two are what the webhook reads back to resume the pipeline.
        listing_url: input.airbnbUrl,
        email: input.email,
        airbnb_url: input.airbnbUrl, // kept for the spec's naming; duplicate of listing_url
        submission_context: "repeat-review",
        is_hh_member: String(input.isHhMember),
      },
      success_url: successUrl,
      cancel_url: `${baseUrl}/paywall?cancelled=1`,
    };

    if (input.isHhMember && memberCoupon) {
      params.discounts = [{ coupon: memberCoupon }];
    }

    const session = await stripe.checkout.sessions.create(params);
    return session.url;
  } catch (err: any) {
    console.error("createPaywallCheckout failed:", err.message);
    return null;
  }
}
