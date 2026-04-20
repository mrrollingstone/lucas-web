import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

/**
 * /how-it-works
 *
 * Explains the Lucas process in three concrete steps and shows what the host
 * gets for it. Linked from the "How it works" nav item on the landing page.
 *
 * Structure:
 *   Sticky nav bar (matches /sample)
 *   Hero — "Three steps. About two minutes."
 *   Step 1 → Step 2 → Step 3 (numbered cards with visual mockups)
 *   What's in your report (6-tile benefits grid)
 *   Why it works (3-column explainer of the AI analysis)
 *   Testimonial (Alex)
 *   FAQ
 *   Final CTA
 */

export const metadata: Metadata = {
  title: "How it works · Hello Hosty",
  description:
    "Paste your Airbnb URL, give us your email, get a professional listing review in your inbox. Here's exactly what happens in the two minutes in between — and what you get back.",
};

// ─── Sub-components ────────────────────────────────────────────────────────

function StepCard({
  num,
  eyebrow,
  title,
  body,
  time,
  mock,
  reverse = false,
}: {
  num: string;
  eyebrow: string;
  title: string;
  body: string;
  time: string;
  mock: React.ReactNode;
  reverse?: boolean;
}) {
  return (
    <section className="mx-auto mt-6 max-w-4xl rounded-card bg-white shadow-card">
      <div
        className={`grid gap-8 p-8 sm:p-12 ${
          reverse ? "sm:grid-cols-[1fr_auto]" : "sm:grid-cols-[auto_1fr]"
        }`}
      >
        {!reverse && (
          <div className="flex items-center justify-center">{mock}</div>
        )}
        <div className={reverse ? "order-first sm:order-none" : ""}>
          <div className="mb-3 flex items-baseline gap-4">
            <span className="font-display text-[72px] leading-none text-brand-teal opacity-85">
              {num}
            </span>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-teal">
                {eyebrow}
              </div>
              <h2 className="mt-1 font-serif text-[26px] font-semibold leading-tight text-brand-dark">
                {title}
              </h2>
            </div>
          </div>
          <p className="max-w-[520px] text-[16px] leading-relaxed text-brand-grey600">
            {body}
          </p>
          <div className="mt-5 inline-flex items-center gap-2 rounded-input bg-brand-tealFaint/60 px-3 py-1.5 text-[12px] font-semibold text-brand-tealDark">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            {time}
          </div>
        </div>
        {reverse && (
          <div className="flex items-center justify-center">{mock}</div>
        )}
      </div>
    </section>
  );
}

function MockUrlInput() {
  return (
    <div className="relative w-full max-w-[340px]">
      <div className="rounded-[14px] border-2 border-brand-teal bg-white p-1.5 shadow-card">
        <div className="flex items-center gap-2 rounded-[10px] bg-brand-mist/60 px-3 py-2.5">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-brand-grey400"
          >
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          <span className="truncate text-[11px] font-medium text-brand-dark">
            airbnb.com/rooms/5811090…
          </span>
        </div>
        <button className="mt-1.5 w-full rounded-[8px] bg-brand-red py-2 text-[12px] font-bold text-white">
          Get free review
        </button>
      </div>
      <div className="mt-3 text-center text-[11px] text-brand-grey400">
        Paste · 10 seconds
      </div>
    </div>
  );
}

function MockScanning() {
  return (
    <div className="w-full max-w-[340px] rounded-card bg-white p-5 shadow-card">
      <div className="mb-3 flex items-center gap-2 border-b border-brand-grey200 pb-2.5">
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-brand-teal" />
        <span className="text-[12px] font-semibold text-brand-dark">
          Running AI analysis…
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <div className="scan-line" />
        <div className="scan-line" />
        <div className="scan-line" />
        <div className="scan-line" />
      </div>
      <div className="mt-4 space-y-1.5">
        <div className="flex items-center gap-2 text-[11px] text-brand-teal">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-teal" />
          Scraped 26 photos
        </div>
        <div className="flex items-center gap-2 text-[11px] text-brand-teal">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-teal" />
          Parsed 367 reviews
        </div>
        <div className="flex items-center gap-2 text-[11px] text-brand-grey400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-teal" />
          Scoring against best practice…
        </div>
      </div>
    </div>
  );
}

function MockInbox() {
  return (
    <div className="w-full max-w-[340px] rounded-card bg-white p-5 shadow-card">
      <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-brand-grey400">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
        Inbox · 1 new
      </div>
      <div className="rounded-input border border-brand-tealLight bg-brand-tealFaint/40 p-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-teal text-[10px] font-bold text-white">
            HH
          </div>
          <div className="flex-1">
            <div className="text-[11px] font-bold text-brand-dark">
              Hello Hosty
            </div>
            <div className="text-[10px] text-brand-grey400">Just now</div>
          </div>
        </div>
        <div className="mt-2.5 text-[12px] font-semibold text-brand-dark">
          Your listing review is ready
        </div>
        <div className="mt-1 line-clamp-2 text-[10px] text-brand-grey600">
          Overall score: 82/100 · 5 quick wins · paste-ready copy inside…
        </div>
        <div className="mt-3 flex items-center gap-1.5 rounded-md bg-white px-2 py-1.5">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-brand-red"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className="text-[10px] font-medium text-brand-dark">
            Listing_Review.pdf
          </span>
        </div>
      </div>
    </div>
  );
}

function BenefitTile({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-card bg-white p-6 shadow-card">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-input bg-brand-tealFaint/70 text-brand-tealDark">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-5 w-5"
        >
          {icon}
        </svg>
      </div>
      <h3 className="mb-1.5 font-serif text-[18px] font-semibold text-brand-dark">
        {title}
      </h3>
      <p className="text-[14px] leading-relaxed text-brand-grey600">{body}</p>
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: React.ReactNode }) {
  return (
    <div className="border-b border-brand-grey200 py-5 last:border-b-0">
      <h3 className="mb-2 font-serif text-[18px] font-semibold text-brand-dark">
        {q}
      </h3>
      <p className="text-[15px] leading-relaxed text-brand-grey600">{a}</p>
    </div>
  );
}

// ─── The page ──────────────────────────────────────────────────────────────

export default function HowItWorksPage() {
  return (
    <main className="bg-brand-mist pb-24">
      {/* Sticky nav (mirrors /sample) */}
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
              href="/sample"
              className="text-sm font-medium text-brand-grey600 transition-colors hover:text-brand-dark"
            >
              Sample report
            </Link>
            <Link
              href="/"
              className="rounded-input bg-brand-red px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-brand-redHover"
            >
              Get your free review
            </Link>
          </div>
          <Link
            href="/"
            className="rounded-input bg-brand-red px-3 py-1.5 text-[12px] font-semibold text-white sm:hidden"
          >
            Get free review
          </Link>
        </div>
      </div>

      {/* ═════════════════ HERO ═════════════════ */}
      <section className="mx-auto max-w-3xl px-6 pt-14 text-center">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full bg-brand-tealLight px-4 py-1.5 text-[12px] font-semibold tracking-wide text-brand-tealDark">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="h-3.5 w-3.5"
          >
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          How it works
        </div>

        <h1 className="font-display text-[clamp(36px,5vw,56px)] leading-[1.1] text-brand-dark">
          Three steps.
          <br />
          <span className="hero-highlight text-brand-teal">About two minutes.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-[560px] text-[17px] leading-relaxed text-brand-grey600">
          Paste your Airbnb URL, give us an email, open the PDF. That&apos;s
          the whole process — and by the end of it you&apos;ve got a
          professional listing review with scores, quick wins, and
          paste-ready copy for your listing.
        </p>
      </section>

      {/* ═════════════════ STEPS ═════════════════ */}
      <div className="px-6 pt-12">
        <StepCard
          num="01"
          eyebrow="Paste"
          title="Drop in your Airbnb listing URL"
          body="Open your listing on Airbnb, copy the web address, and paste it into the Hello Hosty homepage. That's all we need to get started — no account, no card, no Airbnb integration to authorise."
          time="About 10 seconds"
          mock={<MockUrlInput />}
        />

        <StepCard
          num="02"
          eyebrow="Let the AI work"
          title="Our AI reads your listing the way a top host would"
          body="We pull every photo, every word of your description, your amenities, your pricing, and the full review history. Then we score the listing against what's actually working for top-performing Airbnbs — content, photos, pricing, SEO, guest sentiment."
          time="Under 2 minutes"
          mock={<MockScanning />}
          reverse
        />

        <StepCard
          num="03"
          eyebrow="Open your report"
          title="A full PDF lands in your inbox"
          body="You'll get a professional, multi-page PDF with your overall score, category breakdowns, the top quick wins ranked by impact, and rewritten paste-ready copy for your title, description, and space. Copy, paste into Airbnb, done."
          time="Arrives in your inbox"
          mock={<MockInbox />}
        />
      </div>

      {/* ═════════════════ WHAT'S INSIDE ═════════════════ */}
      <section className="mx-auto mt-20 max-w-5xl px-6">
        <div className="mx-auto max-w-[640px] text-center">
          <p className="text-[12px] font-bold uppercase tracking-[0.18em] text-brand-teal">
            What you get back
          </p>
          <h2 className="mt-3 font-display text-[clamp(30px,4vw,44px)] leading-tight text-brand-dark">
            Not a generic checklist.
            <br />
            <span className="text-brand-teal">Your listing, dissected.</span>
          </h2>
          <p className="mt-4 text-[16px] leading-relaxed text-brand-grey600">
            Every report is written from scratch for the listing you paste in.
            Here&apos;s what&apos;s inside.
          </p>
        </div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <BenefitTile
            icon={
              <>
                <circle cx="12" cy="12" r="10" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </>
            }
            title="An overall score out of 100"
            body="One number that tells you, at a glance, how your listing stacks up against top-performers in your category."
          />
          <BenefitTile
            icon={
              <>
                <path d="M3 3v18h18" />
                <path d="M7 14l4-4 4 4 5-5" />
              </>
            }
            title="Category breakdowns"
            body="Separate scores for content, photos, pricing, amenities, SEO, and host response — so you know exactly which lever to pull first."
          />
          <BenefitTile
            icon={
              <>
                <polyline points="20 6 9 17 4 12" />
              </>
            }
            title="A ranked quick-wins list"
            body="The three to five highest-impact changes you can make today, ordered by expected lift. Each one includes an estimated time and impact rating."
          />
          <BenefitTile
            icon={
              <>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="9" y1="13" x2="15" y2="13" />
                <line x1="9" y1="17" x2="15" y2="17" />
              </>
            }
            title="Paste-ready optimised copy"
            body="A rewritten title, 'about this place', and 'the space' section — written in your listing's voice. Copy, paste into Airbnb, hit save."
          />
          <BenefitTile
            icon={
              <>
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </>
            }
            title="Photo sequencing feedback"
            body="Which photo should be the hero, what's missing from the gallery, and which shots are quietly hurting your click-through rate."
          />
          <BenefitTile
            icon={
              <>
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </>
            }
            title="What your guests are saying"
            body="A sentiment read on every review — what reviewers love, the one friction point that keeps resurfacing, and how to pre-empt it in your listing copy."
          />
        </div>

        <div className="mt-10 text-center">
          <Link
            href="/sample"
            className="inline-flex items-center gap-2 text-[14px] font-semibold text-brand-tealDark hover:text-brand-teal"
          >
            See a full worked example
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </Link>
        </div>
      </section>

      {/* ═════════════════ WHY IT WORKS ═════════════════ */}
      <section className="mx-auto mt-24 max-w-5xl px-6">
        <div className="rounded-card bg-brand-dark px-8 py-14 text-center text-white sm:px-16">
          <p className="text-[12px] font-bold uppercase tracking-[0.18em] text-brand-teal">
            Why it works
          </p>
          <h2 className="mx-auto mt-3 max-w-[640px] font-display text-[clamp(28px,3.6vw,40px)] leading-tight">
            It&apos;s not Airbnb&apos;s generic advice. It&apos;s what&apos;s
            actually working right now — applied to your listing.
          </h2>

          <div className="mt-12 grid gap-10 text-left sm:grid-cols-3">
            <div>
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-input bg-brand-teal/20 text-brand-teal">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-5 w-5"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>
              <h3 className="font-serif text-[18px] font-semibold">
                We read your full listing
              </h3>
              <p className="mt-2 text-[14px] leading-relaxed text-white/70">
                Every photo, every amenity, every word, every review. No
                skimming. Most hosts have never had a second pair of eyes do
                this.
              </p>
            </div>
            <div>
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-input bg-brand-teal/20 text-brand-teal">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-5 w-5"
                >
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
              </div>
              <h3 className="font-serif text-[18px] font-semibold">
                Benchmarked against top-performers
              </h3>
              <p className="mt-2 text-[14px] leading-relaxed text-white/70">
                We score your listing against the patterns we see in
                Guest Favourites and Superhost top performers — not
                against a static template.
              </p>
            </div>
            <div>
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-input bg-brand-teal/20 text-brand-teal">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="h-5 w-5"
                >
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
              </div>
              <h3 className="font-serif text-[18px] font-semibold">
                You get action, not theory
              </h3>
              <p className="mt-2 text-[14px] leading-relaxed text-white/70">
                Every recommendation is a concrete change with a ranked
                impact — plus the rewritten copy, ready to paste. No
                homework, no &ldquo;you should consider…&rdquo;
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ═════════════════ TESTIMONIAL ═════════════════ */}
      <section className="mx-auto mt-20 max-w-3xl px-6">
        <div className="rounded-card bg-white p-10 text-center shadow-card sm:p-14">
          <div className="mb-5 flex justify-center gap-1 text-[18px] text-[#F5B042]">
            ★ ★ ★ ★ ★
          </div>
          <blockquote className="font-serif text-[clamp(22px,2.6vw,28px)] leading-[1.4] text-brand-dark">
            “It has improved my life. Before, I was just guessing at what guests
            wanted. Now I know what to change — and the rewritten copy saved
            me hours of sitting there staring at a blank screen.”
          </blockquote>
          <div className="mt-8 flex items-center justify-center gap-3 text-[13px]">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-teal font-bold text-white">
              A
            </div>
            <div className="text-left">
              <div className="font-semibold text-brand-dark">Alex</div>
              <div className="text-brand-grey400">Airbnb host · Hello Hosty customer</div>
            </div>
          </div>
        </div>
      </section>

      {/* ═════════════════ FAQ ═════════════════ */}
      <section className="mx-auto mt-20 max-w-3xl px-6">
        <div className="text-center">
          <p className="text-[12px] font-bold uppercase tracking-[0.18em] text-brand-teal">
            Things hosts ask
          </p>
          <h2 className="mt-3 font-display text-[clamp(28px,3.6vw,40px)] leading-tight text-brand-dark">
            A few practical questions
          </h2>
        </div>

        <div className="mt-10 rounded-card bg-white p-4 shadow-card sm:p-8">
          <FaqItem
            q="Is the first review actually free?"
            a="Yes — your first listing review is completely free. No card required. We ask for your email so we can send the PDF — that's the only string attached."
          />
          <FaqItem
            q="Do I need to connect my Airbnb account?"
            a="No. We work entirely from your public listing URL, the same way a guest browsing Airbnb would see it. Nothing to authorise, no access to your calendar or messages."
          />
          <FaqItem
            q="How long does it take?"
            a="Pasting the URL takes about ten seconds. The AI analysis runs in under two minutes. Your report arrives by email shortly after."
          />
          <FaqItem
            q="Will my listing or guest data be shared?"
            a="No. We analyse your public listing to generate your report — we don't resell it, republish it, or share it with anyone else."
          />
          <FaqItem
            q="What if my listing is on Booking.com or Vrbo?"
            a={
              <>
                Right now Lucas is optimised for Airbnb listings. We&apos;re
                working on Booking.com and Vrbo next —{" "}
                <Link
                  href="/"
                  className="font-semibold text-brand-tealDark hover:text-brand-teal"
                >
                  drop your email on the homepage
                </Link>{" "}
                and we&apos;ll let you know when it&apos;s ready.
              </>
            }
          />
          <FaqItem
            q="Can I get more than one review?"
            a="Yes. Your first review is free; additional listings and re-reviews are available on the Hello Hosty plans. Hello Hosty customers also get 30% off at checkout when they use their account email."
          />
        </div>
      </section>

      {/* ═════════════════ FINAL CTA ═════════════════ */}
      <section className="mx-auto mt-24 max-w-4xl px-6">
        <div className="rounded-card bg-gradient-to-br from-brand-dark to-brand-darkMid px-8 py-14 text-center text-white sm:px-16">
          <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-brand-teal">
            Ready in two minutes
          </p>
          <h2 className="mx-auto mt-3 max-w-[640px] font-display text-[clamp(30px,4vw,44px)] leading-tight">
            Paste your Airbnb URL. We&apos;ll do the rest.
          </h2>
          <p className="mx-auto mt-4 max-w-[460px] text-[15px] leading-relaxed text-white/80">
            Your first listing review is free. No card, no account, no
            commitment — just a proper read of your listing, in your inbox.
          </p>
          <Link
            href="/"
            className="mt-8 inline-flex items-center gap-2 rounded-input bg-brand-red px-8 py-4 text-base font-semibold text-white transition-colors hover:bg-brand-redHover"
          >
            Get my free review
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </Link>
          <p className="mt-6 text-[12px] text-white/50">
            100% free · no card required · report arrives in under 2 minutes
          </p>
        </div>
      </section>
    </main>
  );
}
