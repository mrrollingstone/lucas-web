/**
 * /paywall
 *
 * Shown to almost every user before their review runs (every review is paid;
 * the only callers who skip this page are legacy grandfathered leads). Reached
 * two ways:
 *   1. Redirect from /api/submissions when it returns 402.
 *   2. Bounce-back from a cancelled Stripe Checkout (?cancelled=1).
 *
 * The page is a pure client component — it reads email/url/hh from the query
 * string, then POSTs to /api/submissions again to get a fresh checkout URL.
 * We don't trust the `hh` query flag blindly; the API is the source of truth.
 *
 * Copy: £19 one-off for everyone, £9 for HelloHosty members. No urgency,
 * no fake scarcity.
 */
"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";

function PaywallInner() {
  const sp = useSearchParams();
  const email = sp.get("email") || "";
  const listingUrl = sp.get("url") || "";
  const hhHint = sp.get("hh") === "true";
  const cancelled = sp.get("cancelled") === "1";

  const [isHhMember, setIsHhMember] = useState<boolean | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // On mount, re-POST to /api/submissions with the same email/url so the API
  // returns the authoritative (is_hh_member, checkout_url) pair.
  useEffect(() => {
    if (!email || !listingUrl) {
      setLoading(false);
      setError("missing");
      return;
    }
    let cancelledCall = false;
    (async () => {
      try {
        const res = await fetch("/api/submissions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            listing_url: listingUrl,
            platform: "airbnb",
            is_first_time: false,
            submitted_at: new Date().toISOString(),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelledCall) return;
        if (res.status === 402 && data?.needs_payment) {
          setIsHhMember(Boolean(data.is_hh_member));
          setCheckoutUrl(data.checkout_url || null);
        } else if (res.ok) {
          // Edge case: API decided this wasn't a repeat after all (DB reset?).
          // Surface a friendly message rather than silently confusing the user.
          setError("already-processing");
        } else {
          setError("api");
        }
      } catch {
        if (!cancelledCall) setError("network");
      } finally {
        if (!cancelledCall) setLoading(false);
      }
    })();
    return () => {
      cancelledCall = true;
    };
  }, [email, listingUrl]);

  const effectiveHh = isHhMember ?? hhHint;

  return (
    <main className="min-h-screen bg-brand-mist pb-24">
      {/* ── Nav (mirrors /how-it-works) ── */}
      <div className="sticky top-0 z-40 border-b border-brand-grey200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-3">
          <Link href="/" className="flex items-center gap-2">
            <Image
              src="/Hello_Hosty_Logo.png"
              alt="Hello Hosty"
              width={110}
              height={32}
              className="h-7 w-auto"
            />
          </Link>
          <div className="hidden items-center gap-6 sm:flex">
            <Link
              href="/how-it-works"
              className="text-sm font-medium text-brand-grey600 transition-colors hover:text-brand-dark"
            >
              How it works
            </Link>
            <Link
              href="/sample"
              className="text-sm font-medium text-brand-grey600 transition-colors hover:text-brand-dark"
            >
              Sample report
            </Link>
          </div>
        </div>
      </div>

      {/* ── Hero ── */}
      <section className="mx-auto max-w-3xl px-6 pt-14 text-center">
        {cancelled && (
          <div className="mx-auto mb-6 max-w-md rounded-input bg-brand-tealLight px-4 py-2 text-[13px] text-brand-tealDark">
            No charge made — your checkout was cancelled.
          </div>
        )}
        <h1 className="font-display text-[clamp(34px,4.8vw,52px)] leading-[1.12] text-brand-dark">
          One step from your Lucas review.
        </h1>
        <p className="mx-auto mt-5 max-w-[560px] text-[16px] leading-relaxed text-brand-grey600">
          Your AI listing review is a small paid job &mdash; £19 a run, or £9
          if you&apos;re a Hello Hosty member. Same brilliant report either
          way: scores, quick wins, and ready-to-paste copy, written from
          scratch for this listing.
        </p>
        {email && (
          <p className="mx-auto mt-3 max-w-[560px] text-[13px] text-brand-grey400">
            Showing options for <span className="font-medium text-brand-dark">{email}</span>
          </p>
        )}
      </section>

      {/* ── Cards ── */}
      <section className="mx-auto mt-10 max-w-4xl px-6">
        {loading && <PaywallSkeleton />}
        {!loading && error && <PaywallError kind={error} />}
        {!loading && !error && effectiveHh && (
          <MemberCard
            checkoutUrl={checkoutUrl}
            pending={!checkoutUrl}
          />
        )}
        {!loading && !error && !effectiveHh && (
          <div className="grid gap-6 sm:grid-cols-2">
            <OneOffCard checkoutUrl={checkoutUrl} pending={!checkoutUrl} />
            <MemberUpsellCard />
          </div>
        )}
      </section>

      {/* ── Footer strip ── */}
      <section className="mx-auto mt-16 max-w-3xl px-6 text-center">
        <p className="mx-auto max-w-[620px] text-[14px] leading-relaxed text-brand-grey600">
          Why £19? Each review costs us real compute &mdash; scraping,
          analysis, PDF generation, all written from scratch for your
          listing. £19 keeps the lights on and the work honest. Want to see
          what you&apos;re buying first? <a href="/sample" className="font-medium text-brand-teal hover:text-brand-tealDark">View a sample report &rarr;</a>
        </p>
        <p className="mt-4 text-[13px] text-brand-grey400">
          Need help or got a bulk request?{" "}
          <a
            href="mailto:lucas@hellohosty.com"
            className="font-medium text-brand-teal hover:text-brand-tealDark"
          >
            lucas@hellohosty.com
          </a>
        </p>
      </section>
    </main>
  );
}

/* ─── Card: £19 one-off ─── */
function OneOffCard({
  checkoutUrl,
  pending,
}: {
  checkoutUrl: string | null;
  pending: boolean;
}) {
  return (
    <div className="flex flex-col rounded-card bg-white p-8 shadow-card">
      <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-teal">
        Single review
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="font-display text-[56px] leading-none text-brand-dark">
          £19
        </span>
        <span className="text-[14px] text-brand-grey600">one-off</span>
      </div>
      <p className="mt-4 max-w-[320px] text-[15px] leading-relaxed text-brand-grey600">
        One fresh listing review, delivered to your inbox in minutes.
        Written from scratch for this listing &mdash; scores, quick wins,
        and ready-to-paste copy.
      </p>
      <div className="mt-auto pt-6">
        {pending ? (
          <button
            disabled
            className="w-full rounded-xl bg-brand-grey200 px-6 py-4 text-base font-semibold text-brand-grey400"
          >
            Preparing checkout…
          </button>
        ) : (
          <a
            href={checkoutUrl!}
            className="block w-full rounded-xl bg-brand-red px-6 py-4 text-center text-base font-semibold text-white transition-colors hover:bg-brand-redHover active:scale-[.98]"
          >
            Pay £19 and run it →
          </a>
        )}
      </div>
    </div>
  );
}

/* ─── Card: HH member upsell (for non-members) ─── */
function MemberUpsellCard() {
  return (
    <div className="flex flex-col rounded-card border-2 border-brand-teal bg-white p-8 shadow-card">
      <div className="flex items-center gap-2">
        <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-teal">
          Become a member
        </div>
        <span className="rounded-full bg-brand-tealFaint px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-tealDark">
          Better deal
        </span>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="font-display text-[56px] leading-none text-brand-dark">
          £9
        </span>
        <span className="text-[14px] text-brand-grey600">per review</span>
      </div>
      <p className="mt-4 max-w-[340px] text-[15px] leading-relaxed text-brand-grey600">
        £10 off every future review, plus unlimited access to the Hello Hosty
        platform — everything else it does for your short-stay business.
      </p>
      <div className="mt-auto pt-6">
        <a
          href="https://calendly.com/hellohosty/call-with-clive?utm_source=lucas&utm_medium=paywall"
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full rounded-xl bg-brand-teal px-6 py-4 text-center text-base font-semibold text-white transition-colors hover:bg-brand-tealDark active:scale-[.98]"
        >
          Start your free trial →
        </a>
      </div>
    </div>
  );
}

/* ─── Card: Single-card £9 (when the caller IS an HH member) ─── */
function MemberCard({
  checkoutUrl,
  pending,
}: {
  checkoutUrl: string | null;
  pending: boolean;
}) {
  return (
    <div className="mx-auto max-w-[520px] rounded-card border-2 border-brand-teal bg-white p-10 shadow-card">
      <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-teal">
        Welcome back, member
      </div>
      <h2 className="mt-2 font-serif text-[26px] font-semibold text-brand-dark">
        Your price is £9.
      </h2>
      <p className="mt-3 text-[15px] leading-relaxed text-brand-grey600">
        Your Hello Hosty membership takes £10 off every review — the
        discount is already applied at checkout.
      </p>
      <div className="mt-6 flex items-baseline gap-2">
        <span className="font-display text-[56px] leading-none text-brand-dark">
          £9
        </span>
        <span className="text-[14px] text-brand-grey600 line-through">£19</span>
      </div>
      <div className="mt-6">
        {pending ? (
          <button
            disabled
            className="w-full rounded-xl bg-brand-grey200 px-6 py-4 text-base font-semibold text-brand-grey400"
          >
            Preparing checkout…
          </button>
        ) : (
          <a
            href={checkoutUrl!}
            className="block w-full rounded-xl bg-brand-teal px-6 py-4 text-center text-base font-semibold text-white transition-colors hover:bg-brand-tealDark active:scale-[.98]"
          >
            Pay £9 and run it →
          </a>
        )}
      </div>
    </div>
  );
}

/* ─── Loading / error states ─── */
function PaywallSkeleton() {
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="h-[300px] animate-pulse rounded-card bg-white/60"
        />
      ))}
    </div>
  );
}

function PaywallError({ kind }: { kind: string }) {
  const messages: Record<string, string> = {
    missing:
      "We couldn't tell which listing you're trying to review — head back to the homepage and paste your URL again.",
    "already-processing":
      "Good news — it looks like your review is already in progress. Check your inbox in a couple of minutes.",
    api: "Something went wrong talking to our servers. Try again in a minute, or email lucas@hellohosty.com.",
    network:
      "We couldn't reach the server. Check your connection and try again.",
  };
  return (
    <div className="mx-auto max-w-[520px] rounded-card bg-white p-8 text-center shadow-card">
      <p className="text-[15px] leading-relaxed text-brand-grey600">
        {messages[kind] || messages.api}
      </p>
      <Link
        href="/"
        className="mt-5 inline-block rounded-input bg-brand-red px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-redHover"
      >
        Back to homepage
      </Link>
    </div>
  );
}

export default function PaywallPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-brand-mist">
          <div className="mx-auto max-w-3xl px-6 pt-24 text-center">
            <PaywallSkeleton />
          </div>
        </main>
      }
    >
      <PaywallInner />
    </Suspense>
  );
}
