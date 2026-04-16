import { ReviewForm } from "@/components/ReviewForm";

// Old paid flow — HelloHosty members get 30% off via Stripe coupon.
export default function BuyMemberPage() {
  return <ReviewForm memberTier={true} />;
}
