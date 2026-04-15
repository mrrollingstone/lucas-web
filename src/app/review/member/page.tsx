import { ReviewForm } from "@/components/ReviewForm";

// HelloHosty users land here via email campaigns or in-app links. The form
// flips into member tier. Pricing is the same single multi-currency price
// (£10 / $13.50 / €11.50); member discount is applied as a Stripe coupon,
// not a separate price — wire up STRIPE_MEMBER_COUPON env var when ready.
export default function MemberReviewPage() {
  return <ReviewForm memberTier={true} />;
}
