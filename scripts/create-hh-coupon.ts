/**
 * One-off: create the "HH member 30% off" coupon in Stripe.
 *
 * Run this ONCE per Stripe environment (test, then live). It prints the
 * coupon ID — paste that into Vercel as STRIPE_MEMBER_COUPON.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_...  npx tsx scripts/create-hh-coupon.ts
 *
 * The coupon is intentionally `forever` (no expiry) and `multiple_use` so
 * any HH member who pays for a repeat review can have it applied.
 */
import Stripe from "stripe";

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error("Missing STRIPE_SECRET_KEY in env.");
    process.exit(1);
  }

  const stripe = new Stripe(key, { apiVersion: "2024-06-20" });

  const coupon = await stripe.coupons.create({
    name: "Hello Hosty member — 30% off Lucas reviews",
    percent_off: 30,
    duration: "forever",
    metadata: {
      audience: "hh-members",
      product: "lucas-repeat-review",
    },
  });

  console.log("✅ Coupon created.");
  console.log("   ID:        ", coupon.id);
  console.log("   Percent off:", coupon.percent_off, "%");
  console.log("   Duration:  ", coupon.duration);
  console.log("");
  console.log("Paste this into Vercel:");
  console.log(`   STRIPE_MEMBER_COUPON=${coupon.id}`);
}

main().catch((err) => {
  console.error("Coupon creation failed:", err.message);
  process.exit(1);
});
