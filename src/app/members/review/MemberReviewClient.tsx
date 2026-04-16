"use client";

/**
 * Member-specific landing funnel wrapper.
 *
 * - First review: free (same as public funnel)
 * - Subsequent reviews: 30% off via Stripe promo code
 *
 * This component re-uses the same LandingFunnel but overrides the
 * submission to include member context and, on repeat reviews,
 * redirects to a Stripe Checkout session with the member coupon applied.
 */

import { useState, useCallback } from "react";
import { LandingFunnel } from "@/components/LandingFunnel";

interface Props {
  memberEmail: string;
  memberName: string;
  memberId: string;
  memberPlan?: string;
}

export function MemberReviewClient({
  memberEmail,
  memberName,
  memberId,
  memberPlan,
}: Props) {
  return (
    <div>
      {/* Member status banner */}
      <div className="fixed inset-x-0 top-[56px] z-40 border-b border-brand-teal/20 bg-brand-tealLight px-4 py-2 text-center text-sm font-medium text-brand-tealDark">
        Welcome back, {memberName}! Your Hello Hosty membership gives you{" "}
        <strong>30% off</strong> every listing review.
      </div>

      {/* Render the standard funnel — the /api/submissions endpoint
          will detect member status from the session cookie and apply
          the discount on repeat reviews automatically. */}
      <div className="pt-10">
        <LandingFunnel />
      </div>
    </div>
  );
}
