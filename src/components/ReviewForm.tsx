"use client";

/**
 * Two-step progressive-disclosure form that matches the V6 landing-page flow:
 *   Step 1  — paste listing URL
 *   Step 2  — while "loading animation introduces Lucas", capture name + email
 *   On submit the API decides (based on prior usage) whether to kick off the
 *   scrape directly or redirect to Stripe Checkout.
 *
 * The styling here is intentionally minimal — the final V6 HTML (locked design)
 * should be pasted in and hooked up to these same handlers. All state and
 * submission logic is self-contained so swapping markup is risk-free.
 */
import { useState, useTransition } from "react";

type Props = {
  /** Pre-applied discount for the HH member landing page. */
  memberTier?: boolean;
};

export function ReviewForm({ memberTier = false }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const validUrl = /airbnb\.[a-z.]+\/rooms\/\d+/i.test(url);

  async function submit() {
    setError(null);
    if (!validUrl) {
      setError("That doesn't look like an Airbnb listing URL. It should contain /rooms/<id>.");
      return;
    }
    if (!name.trim() || !/\S+@\S+\.\S+/.test(email)) {
      setError("Name and a valid email, please.");
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          name: name.trim(),
          email: email.trim().toLowerCase(),
          member_tier: memberTier,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong — please try again.");
        return;
      }
      if (data.next === "stripe") {
        window.location.href = data.checkout_url;
      } else {
        window.location.href = "/review/confirmation?email=" + encodeURIComponent(email);
      }
    });
  }

  return (
    <section className="mx-auto max-w-xl px-6 py-16 text-center">
      <p className="text-xs font-semibold uppercase tracking-widest text-brand-teal">
        {memberTier ? "HelloHosty member · 30% off" : "Free on your first listing"}
      </p>
      <h1 className="mt-3 text-4xl md:text-5xl font-semibold leading-tight tracking-tight">
        {memberTier
          ? "Review every listing in your portfolio."
          : "Get a branded review of your Airbnb listing, in minutes."}
      </h1>
      <p className="mt-4 text-brand-ink/70">
        HelloHosty reads every review, scores your listing across six dimensions, and emails
        back a PDF with quick wins and rewritten copy. No dashboard. No waiting.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (step === 1 && validUrl) setStep(2);
          else if (step === 2) submit();
        }}
        className="mt-10 space-y-4 text-left"
      >
        {step >= 1 && (
          <label className="block">
            <span className="text-sm font-medium">Listing URL</span>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://airbnb.co.uk/rooms/…"
              autoFocus
              className="mt-1 w-full rounded-md border border-black/10 bg-white px-4 py-3 shadow-sm focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
            />
          </label>
        )}

        {step >= 2 && (
          <>
            <div className="rounded-md bg-brand-tealFaint/60 px-4 py-3 text-sm text-brand-tealDark">
              <strong>Warming up.</strong> Add your details and we'll get to work the
              moment you hit send.
            </div>
            <label className="block">
              <span className="text-sm font-medium">Your name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-md border border-black/10 bg-white px-4 py-3 shadow-sm focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-md border border-black/10 bg-white px-4 py-3 shadow-sm focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
              />
            </label>
          </>
        )}

        {error && <p className="text-sm text-brand-red">{error}</p>}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-brand-red px-6 py-3 font-semibold text-white shadow-sm transition hover:bg-brand-red/90 disabled:opacity-60"
        >
          {pending
            ? "Working…"
            : step === 1
              ? "Continue"
              : memberTier
                ? "Send my review (£10)"
                : "Send my review"}
        </button>
      </form>

      <p className="mt-6 text-xs text-brand-ink/60">
        First review free · Report lands in minutes, not hours
      </p>
    </section>
  );
}
