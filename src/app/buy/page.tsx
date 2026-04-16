import { ReviewForm } from "@/components/ReviewForm";

// Old paid-upfront flow for repeat non-member reviews.
export default function BuyPage() {
  return <ReviewForm memberTier={false} />;
}
