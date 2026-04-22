"use client";

/**
 * 3-step free-first-review funnel
 *
 * Step 1: Hero — paste Airbnb URL → "Get free review"
 * Step 2: Email collect — frictionless email-only capture
 * Step 3: Animated AI generation → confirmation
 */

import { useState, useCallback, useEffect, useRef } from "react";
import Image from "next/image";

/* ─── Paywall redirect helper ─── *
 * If /api/submissions returns 402 (repeat review — email has already had its
 * free one), bounce to the paywall page with email+url+hh query params so it
 * can render the right pricing card without re-hitting the API immediately.
 * Returns true if we handled the response by redirecting. */
async function maybeRedirectToPaywall(res: Response, email: string, url: string): Promise<boolean> {
  if (res.status !== 402) return false;
  let data: { needs_payment?: boolean; is_hh_member?: boolean; checkout_url?: string } = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON 402 — still treat as paywall */
  }
  if (!data.needs_payment) return false;
  const qs = new URLSearchParams({
    email,
    url,
    hh: String(Boolean(data.is_hh_member)),
  });
  // If the API already minted a checkout URL, we could go straight there, but
  // routing through /paywall gives the user the option to upgrade to HH
  // membership instead of paying the one-off price.
  window.location.href = `/paywall?${qs.toString()}`;
  return true;
}

/* ─── Types ─── */
interface SessionData {
  listing_url: string;
  platform: string;
  email: string;
  submitted_at: string | null;
}

const initialSession: SessionData = {
  listing_url: "",
  platform: "airbnb",
  email: "",
  submitted_at: null,
};

/* ─── Meta Pixel helper — no-ops if fbq isn't on the page ─── */
type FbqFn = (...args: unknown[]) => void;
function fbqTrack(event: string, params?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  const fbq = (window as unknown as { fbq?: FbqFn }).fbq;
  if (typeof fbq === "function") fbq("track", event, params || {});
}

/* ─── Step-dot progress bar ─── *
 * When `showLabels` is true, each dot carries a label underneath so the bar
 * doubles as a 3-step explainer: Paste URL → Lucas reviews → Get your fixes.
 * When false (used on steps 2 & 3 where the user is already in the flow),
 * labels are omitted to save vertical space. */
const STEP_LABELS = ["Paste URL", "Lucas reviews", "Get your fixes"] as const;

function StepsBar({
  current,
  showLabels = false,
}: {
  current: 1 | 2 | 3;
  showLabels?: boolean;
}) {
  return (
    <div className="mb-10 flex items-center justify-center gap-2">
      {[1, 2, 3].map((n, i) => (
        <span key={n} className="flex items-center gap-2">
          <span className="flex flex-col items-center gap-1.5">
            <span
              className={`h-2.5 rounded-full transition-all duration-400 ${
                n < current
                  ? "w-2.5 bg-brand-teal"
                  : n === current
                    ? "w-8 rounded bg-brand-teal"
                    : "w-2.5 bg-brand-grey200"
              }`}
            />
            {showLabels && (
              <span
                className={`whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors max-sm:text-[9px] ${
                  n === current ? "text-brand-tealDark" : "text-brand-grey400"
                }`}
              >
                {STEP_LABELS[n - 1]}
              </span>
            )}
          </span>
          {i < 2 && (
            <span className={`h-0.5 w-6 bg-brand-grey200 ${showLabels ? "mb-5" : ""}`} />
          )}
        </span>
      ))}
    </div>
  );
}

/* ─── Generation status messages ─── */
const GEN_MESSAGES = [
  "Connecting to Airbnb\u2026",
  "Scraping listing data\u2026",
  "Extracting photos & amenities\u2026",
  "Reading reviews & ratings\u2026",
  "Pulling pricing data\u2026",
  "Running AI analysis\u2026",
  "Scoring against best practices\u2026",
  "Writing optimised copy\u2026",
  "Building your PDF report\u2026",
  "Sending to your inbox\u2026",
];

/* ═══════════════════════════ MAIN COMPONENT ═══════════════════════════ */
export function LandingFunnel() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [session, setSession] = useState<SessionData>(initialSession);

  /* Step 1 */
  const [urlValue, setUrlValue] = useState("");
  const [urlError, setUrlError] = useState(false);
  // Ref to the URL input so the "Get my free review" CTA below the fold can
  // scroll + focus it cleanly.
  const heroInputRef = useRef<HTMLInputElement | null>(null);

  /* Step 2 */
  const [emailValue, setEmailValue] = useState("");
  const [emailError, setEmailError] = useState(false);
  // "Checking your account…" loader while we wait on /api/submissions. This
  // is usually ~500ms — just long enough to cover the Stripe member lookup on
  // repeat submissions.
  const [emailSubmitting, setEmailSubmitting] = useState(false);

  /* Summit-campaign arrivals (?email=…&utm_source=summit) */
  const [isSummitLead, setIsSummitLead] = useState(false);
  const [emailPrefilled, setEmailPrefilled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const qEmail = params.get("email");
    const qSource = params.get("utm_source");
    const qUrl = params.get("url");
    if (qEmail && qEmail.includes("@") && qEmail.includes(".")) {
      setEmailValue(qEmail);
      setSession((s) => ({ ...s, email: qEmail }));
      setEmailPrefilled(true);
    }
    if (qSource === "summit") setIsSummitLead(true);
    // Handoff from hellohosty.com homepage block — pre-fill step 1 with the
    // URL the visitor pasted there. Same airbnb/abnb validation as submitUrl.
    if (qUrl && (qUrl.includes("airbnb") || qUrl.includes("abnb"))) {
      setUrlValue(qUrl);
      setSession((s) => ({ ...s, listing_url: qUrl }));
    }
  }, []);

  /* Step 3 — generation animation */
  const [genMsgIndex, setGenMsgIndex] = useState(0);
  const [genDone, setGenDone] = useState(false);
  const [completedSteps, setCompletedSteps] = useState(0);

  /* Navbar scroll shadow */
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 10);
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, []);

  /* Top-nav "Get started" URL modal */
  const [showUrlModal, setShowUrlModal] = useState(false);
  useEffect(() => {
    if (!showUrlModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowUrlModal(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [showUrlModal]);

  /* "Email me a link to finish later" escape-hatch modal — Step 1
   * Captures people who don't have their Airbnb URL to hand (most Meta-ad
   * mobile traffic). POSTs to /api/later-link, which tags them in Mailchimp
   * and sends a transactional email with a prefilled magic link. */
  const [showLaterModal, setShowLaterModal] = useState(false);
  const [laterEmail, setLaterEmail] = useState("");
  const [laterError, setLaterError] = useState(false);
  const [laterSubmitting, setLaterSubmitting] = useState(false);
  const [laterSent, setLaterSent] = useState(false);

  useEffect(() => {
    if (!showLaterModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowLaterModal(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [showLaterModal]);

  const submitLater = useCallback(async () => {
    const email = laterEmail.trim();
    if (!email || !email.includes("@") || !email.includes(".")) {
      setLaterError(true);
      return;
    }
    setLaterError(false);
    setLaterSubmitting(true);
    try {
      const params = new URLSearchParams(window.location.search);
      const res = await fetch("/api/later-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          utm_source: params.get("utm_source") || undefined,
          utm_campaign: params.get("utm_campaign") || undefined,
        }),
      });
      if (res.ok) {
        fbqTrack("Lead", { content_name: "lucas-later-link" });
        setLaterSent(true);
      } else {
        setLaterError(true);
      }
    } catch {
      // Network blip — optimistically flip to success; the contact will have
      // been upserted on the server side in most cases.
      setLaterSent(true);
    } finally {
      setLaterSubmitting(false);
    }
  }, [laterEmail]);

  /* ─── Navigation ─── */
  const goToStep = useCallback(
    (n: 1 | 2 | 3) => {
      setStep(n);
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [],
  );

  /* Scroll the hero input into view and focus it — used by below-fold CTAs. */
  const focusHeroInput = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    // Give the smooth-scroll a beat before focusing so we don't double-jump.
    setTimeout(() => {
      heroInputRef.current?.focus({ preventScroll: true });
    }, 450);
  }, []);

  /* ─── Step 1 → 2 (or straight to 3 for summit leads with pre-filled email) ─── */
  const submitUrl = useCallback(() => {
    const url = urlValue.trim();
    if (!url || (!url.includes("airbnb") && !url.includes("abnb"))) {
      setUrlError(true);
      return;
    }
    setUrlError(false);
    setShowUrlModal(false);
    setSession((s) => ({ ...s, listing_url: url }));

    // Email already supplied via ?email= (summit-campaign landing): skip Step 2
    // and submit directly to the pipeline.
    if (emailPrefilled && emailValue) {
      const now = new Date().toISOString();
      const payload = {
        email: emailValue,
        listing_url: url,
        platform: session.platform,
        is_first_time: true,
        submitted_at: now,
        ...(isSummitLead ? { utm_source: "summit" } : {}),
      };
      setSession((s) => ({ ...s, email: emailValue, submitted_at: now }));
      // Branch on 402 (repeat review → paywall). Await the response so the
      // redirect happens before the generation animation starts.
      (async () => {
        let redirected = false;
        try {
          const res = await fetch("/api/submissions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          redirected = await maybeRedirectToPaywall(res, emailValue, url);
        } catch {
          /* network blip — continue to step 3, user will still get the email */
        }
        if (redirected) return;
        if (isSummitLead) {
          fbqTrack("CompleteRegistration", { content_name: "lucas-summit-url-submit" });
        } else {
          fbqTrack("Lead", { content_name: "lucas-free-review" });
        }
        goToStep(3);
      })();
      return;
    }

    goToStep(2);
  }, [urlValue, goToStep, emailPrefilled, emailValue, isSummitLead, session.platform]);

  /* ─── Step 2 → 3: Submit email & start pipeline ─── */
  const submitEmail = useCallback(async () => {
    const email = emailValue.trim();
    if (!email || !email.includes("@") || !email.includes(".")) {
      setEmailError(true);
      return;
    }
    setEmailError(false);

    const now = new Date().toISOString();
    const payload = {
      email,
      listing_url: session.listing_url,
      platform: session.platform,
      is_first_time: true,
      submitted_at: now,
    };

    setSession((s) => ({ ...s, email, submitted_at: now }));

    // Branch on 402 (repeat review → paywall). Await the response so we don't
    // flash the generation animation before redirecting.
    setEmailSubmitting(true);
    let redirected = false;
    try {
      const res = await fetch("/api/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      redirected = await maybeRedirectToPaywall(res, email, session.listing_url);
    } catch {
      /* swallow — step 3 still plays; pipeline failure will surface via email */
    }
    if (redirected) {
      // Leave the loader up — the redirect is about to navigate away.
      return;
    }
    setEmailSubmitting(false);

    // Meta Pixel: standard Lead event on email capture
    fbqTrack("Lead", { content_name: "lucas-free-review" });

    goToStep(3);
  }, [emailValue, session, goToStep]);

  /* ─── Generation animation driver ─── */
  useEffect(() => {
    if (step !== 3) return;

    // Cycle through generation messages
    const msgIv = setInterval(() => {
      setGenMsgIndex((prev) => {
        if (prev < GEN_MESSAGES.length - 1) return prev + 1;
        return prev;
      });
    }, 2200);

    // Progress the timeline steps
    const stepIv = setInterval(() => {
      setCompletedSteps((prev) => {
        if (prev < 5) return prev + 1;
        return prev;
      });
    }, 3500);

    // Mark as done after all messages have cycled
    const doneTimer = setTimeout(() => {
      setGenDone(true);
    }, GEN_MESSAGES.length * 2200 + 1000);

    return () => {
      clearInterval(msgIv);
      clearInterval(stepIv);
      clearTimeout(doneTimer);
    };
  }, [step]);

  /* ═══════════════════════════ RENDER ═══════════════════════════ */
  return (
    <>
      {/* ── NAV ── */}
      <nav
        className={`fixed inset-x-0 top-0 z-50 flex items-center justify-between bg-white px-5 py-3.5 transition-shadow duration-300 sm:px-10 ${
          scrolled ? "shadow-md" : "shadow-[0_1px_0_rgba(0,0,0,.06)]"
        }`}
      >
        <a
          href="https://www.hellohosty.com"
          className="flex items-center gap-3"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Lucas, by Hello Hosty"
        >
          <Image
            src="/Hello_Hosty_Logo.png"
            alt="Hello Hosty"
            width={120}
            height={40}
            className="h-[30px] w-auto"
            priority
          />
          <span
            aria-hidden
            className="h-5 w-px bg-brand-grey200"
          />
          <span className="font-serif text-[20px] font-semibold tracking-tight text-brand-tealDark max-sm:text-[17px]">
            Lucas
          </span>
        </a>
        <div className="hidden items-center gap-8 sm:flex">
          <a
            href="/how-it-works"
            className="text-sm font-medium text-brand-grey600 transition-colors hover:text-brand-dark"
          >
            How it works
          </a>
          <a
            href="/sample"
            className="text-sm font-medium text-brand-grey600 transition-colors hover:text-brand-dark"
          >
            Sample report
          </a>
          <button
            onClick={() => setShowUrlModal(true)}
            className="rounded-lg bg-brand-teal px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-tealDark"
          >
            Get started
          </button>
        </div>
      </nav>

      {/* ── "Get started" URL modal ── */}
      {showUrlModal && (
        <div
          className="animate-fade-up fixed inset-0 z-[100] flex items-center justify-center bg-black/50 px-4 py-6 backdrop-blur-sm"
          onClick={() => setShowUrlModal(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="url-modal-title"
        >
          <div
            className="relative w-full max-w-[520px] rounded-card bg-white p-8 shadow-cardLg max-sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setShowUrlModal(false)}
              aria-label="Close"
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-brand-grey400 transition-colors hover:bg-brand-grey200 hover:text-brand-dark"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>

            <h2
              id="url-modal-title"
              className="mb-2 text-center font-serif text-[26px] font-semibold text-brand-dark max-sm:text-[22px]"
            >
              Paste your Airbnb URL here
            </h2>
            <p className="mb-6 text-center text-sm leading-relaxed text-brand-grey600">
              We&apos;ll review your listing with AI and email you a free
              professional report.
            </p>

            <input
              type="text"
              value={urlValue}
              onChange={(e) => {
                setUrlValue(e.target.value);
                if (urlError) setUrlError(false);
              }}
              onKeyDown={(e) => e.key === "Enter" && submitUrl()}
              placeholder="https://airbnb.com/rooms/..."
              autoFocus
              className={`w-full rounded-[14px] border-2 bg-white px-4 py-3.5 font-sans text-base outline-none transition-all focus:border-brand-teal focus:shadow-[0_0_0_4px_rgba(43,181,178,.12)] ${
                urlError ? "border-brand-red" : "border-brand-grey200"
              }`}
            />
            {urlError && (
              <p className="mt-2 text-[13px] text-brand-red">
                Please enter a valid Airbnb listing URL
              </p>
            )}

            <button
              type="button"
              onClick={submitUrl}
              className="mt-5 w-full rounded-xl bg-brand-red px-6 py-4 text-base font-semibold text-white transition-colors hover:bg-brand-redHover active:scale-[.98]"
            >
              Try for free now
            </button>

            <p className="mt-4 text-center text-[13px] text-brand-grey400">
              100% free&nbsp;&mdash; no card required
            </p>
          </div>
        </div>
      )}

      {/* ── "Email me a link to finish later" escape-hatch modal ── */}
      {showLaterModal && (
        <div
          className="animate-fade-up fixed inset-0 z-[100] flex items-center justify-center bg-black/50 px-4 py-6 backdrop-blur-sm"
          onClick={() => setShowLaterModal(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="later-modal-title"
        >
          <div
            className="relative w-full max-w-[520px] rounded-card bg-white p-8 shadow-cardLg max-sm:p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setShowLaterModal(false)}
              aria-label="Close"
              className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-brand-grey400 transition-colors hover:bg-brand-grey200 hover:text-brand-dark"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>

            {!laterSent ? (
              <>
                <h2
                  id="later-modal-title"
                  className="mb-2 text-center font-serif text-[26px] font-semibold text-brand-dark max-sm:text-[22px]"
                >
                  Email me a link to finish later
                </h2>
                <p className="mb-6 text-center text-sm leading-relaxed text-brand-grey600">
                  Pop your email in and we&apos;ll send you a link. Grab your
                  Airbnb URL when you&apos;ve got a minute, tap the link, and
                  your free review is 60 seconds away.
                </p>

                <input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={laterEmail}
                  onChange={(e) => {
                    setLaterEmail(e.target.value);
                    if (laterError) setLaterError(false);
                  }}
                  onKeyDown={(e) =>
                    e.key === "Enter" && !laterSubmitting && submitLater()
                  }
                  placeholder="you@example.com"
                  autoFocus
                  disabled={laterSubmitting}
                  className={`w-full rounded-[14px] border-2 bg-white px-4 py-3.5 font-sans text-base outline-none transition-all focus:border-brand-teal focus:shadow-[0_0_0_4px_rgba(43,181,178,.12)] ${
                    laterError ? "border-brand-red" : "border-brand-grey200"
                  }`}
                />
                {laterError && (
                  <p className="mt-2 text-[13px] text-brand-red">
                    Please enter a valid email address
                  </p>
                )}

                <button
                  type="button"
                  onClick={submitLater}
                  disabled={laterSubmitting}
                  className="mt-5 w-full rounded-xl bg-brand-red px-6 py-4 text-base font-semibold text-white transition-colors hover:bg-brand-redHover active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {laterSubmitting ? "Sending\u2026" : "Email me the link"}
                </button>

                <p className="mt-4 text-center text-[13px] text-brand-grey400">
                  We&apos;ll only email you about your free review.
                </p>
              </>
            ) : (
              <>
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-teal/10 text-brand-teal">
                  <svg
                    width="30"
                    height="30"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <h2 className="mb-2 text-center font-serif text-[26px] font-semibold text-brand-dark max-sm:text-[22px]">
                  Link is on its way
                </h2>
                <p className="mb-6 text-center text-sm leading-relaxed text-brand-grey600">
                  Check <strong>{laterEmail}</strong> in the next minute or two
                  for your link. When you&apos;re ready, grab your Airbnb
                  listing URL, tap the button in the email, and paste it in.
                </p>
                <button
                  type="button"
                  onClick={() => setShowLaterModal(false)}
                  className="w-full rounded-xl bg-brand-teal px-6 py-4 text-base font-semibold text-white transition-colors hover:bg-brand-tealDark active:scale-[.98]"
                >
                  Got it
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Floating key video ── */}
      <div className="pointer-events-none fixed -bottom-5 -right-5 z-50 h-[200px] w-[200px] opacity-30 drop-shadow-[0_8px_32px_rgba(0,0,0,.15)] sm:h-[200px] sm:w-[200px] max-sm:h-[120px] max-sm:w-[120px]">
        <video
          autoPlay
          loop
          muted
          playsInline
          className="h-full w-full object-contain"
        >
          <source src="/Untitled_design__1_.mp4" type="video/mp4" />
        </video>
      </div>

      {/* ════════════════════ STEP 1: HERO + BELOW-FOLD ════════════════════ */}
      {step === 1 && (
        <>
          <section className="animate-fade-up relative overflow-hidden px-6 pb-12 pt-[120px]">
            {/* ── Background blobs — irregular, hand-drawn echo of the ad creative ── */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
            >
              {/* Top-left red — kidney with a bulge pointing inward */}
              <svg
                className="blob blob-1 absolute -left-[8%] -top-[14%] h-[680px] w-[680px] opacity-[0.45] max-sm:h-[380px] max-sm:w-[380px]"
                viewBox="0 0 600 600"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  fill="#f84455"
                  d="M100,170 C60,80 180,20 300,40 C440,60 560,160 540,300 C530,360 460,320 420,360 C400,400 460,440 420,500 C370,560 250,560 170,510 C60,440 20,340 60,260 C80,220 130,250 100,170 Z"
                />
              </svg>
              {/* Top-right teal — wavy tongue with two bumps along the bottom */}
              <svg
                className="blob blob-2 absolute -right-[10%] top-[8%] h-[620px] w-[620px] opacity-[0.52] max-sm:h-[340px] max-sm:w-[340px]"
                viewBox="0 0 600 600"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  fill="#2BB5B2"
                  d="M260,40 C400,20 530,100 550,220 C570,320 490,360 490,420 C490,470 420,510 330,500 C260,530 200,460 180,420 C150,390 60,420 40,330 C20,230 90,160 160,130 C210,110 170,60 260,40 Z"
                />
              </svg>
              {/* Bottom-left teal — lopsided drop with a pointy top-right */}
              <svg
                className="blob blob-3 absolute -bottom-[16%] -left-[4%] h-[560px] w-[560px] opacity-[0.42] max-sm:h-[300px] max-sm:w-[300px]"
                viewBox="0 0 600 600"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  fill="#2BB5B2"
                  d="M80,240 C50,140 170,60 290,70 C380,60 430,160 480,180 C550,210 540,320 490,390 C430,480 310,520 210,490 C110,470 30,400 40,320 C40,290 100,310 80,240 Z"
                />
              </svg>
              {/* Bottom-right red — banana / comma shape */}
              <svg
                className="blob blob-4 absolute -bottom-[10%] -right-[6%] h-[520px] w-[520px] opacity-[0.42] max-sm:hidden"
                viewBox="0 0 600 600"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  fill="#f84455"
                  d="M140,60 C260,20 410,90 470,210 C510,310 440,360 420,420 C380,500 250,520 160,470 C60,410 20,320 50,230 C70,170 110,140 140,60 Z"
                />
              </svg>
              {/* Mid-left accent teal — small curly squiggle */}
              <svg
                className="blob blob-5 absolute left-[-3%] top-[38%] h-[220px] w-[220px] opacity-[0.40] max-sm:hidden"
                viewBox="0 0 600 600"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  fill="#2BB5B2"
                  d="M180,60 C280,30 400,90 430,190 C460,290 400,400 300,430 C200,460 100,390 90,300 C80,210 120,130 180,60 Z"
                />
              </svg>
            </div>

            <div className="relative mx-auto max-w-[720px] text-center">
              <StepsBar current={1} showLabels />

              {/* Title — direct echo of the ad headline ("Don't blame Airbnb…")
                  keeps the emotional thread intact from click to load. */}
              <h1 className="mb-6 font-display text-[clamp(40px,5.4vw,68px)] font-normal leading-[1.08] tracking-tight text-brand-dark max-sm:text-[34px]">
                <span className="hero-highlight">
                  Still think it&apos;s
                </span>
                <br />
                <span className="hero-highlight italic text-brand-red">
                  Airbnb&apos;s fault?
                </span>
              </h1>

              {/* Subtitle — offer + speed, plain prose */}
              <p className="mx-auto mb-8 max-w-[560px] text-[16px] leading-relaxed text-brand-grey600 max-sm:text-[15px]">
                Paste your listing&nbsp;&mdash; Lucas scores it, finds the weak
                spots, and hands you the fixes in under 60&nbsp;seconds.
              </p>

              {/* URL input */}
              <div className="relative mx-auto mb-4 flex max-w-[560px] flex-col sm:block">
                <svg
                  className="absolute left-[18px] top-1/2 -translate-y-1/2 text-brand-grey400 max-sm:top-7"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                <input
                  ref={heroInputRef}
                  type="text"
                  value={urlValue}
                  onChange={(e) => {
                    setUrlValue(e.target.value);
                    if (urlError) setUrlError(false);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && submitUrl()}
                  placeholder="Paste your Airbnb listing URL"
                  aria-invalid={urlError}
                  aria-describedby={urlError ? "url-error" : undefined}
                  className={`w-full rounded-[14px] border-2 bg-white py-[18px] pl-[52px] pr-[180px] font-sans text-base outline-none transition-all focus:border-brand-teal focus:shadow-[0_0_0_4px_rgba(43,181,178,.12)] max-sm:pr-4 max-sm:text-sm ${
                    urlError ? "border-brand-red" : "border-brand-grey200"
                  }`}
                />
                <button
                  onClick={submitUrl}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center gap-1.5 rounded-input bg-brand-red px-6 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-brand-redHover active:scale-[.97] max-sm:relative max-sm:right-auto max-sm:top-auto max-sm:mt-3 max-sm:w-full max-sm:translate-y-0 max-sm:justify-center max-sm:rounded-xl max-sm:py-4"
                >
                  Try for free now
                  <span aria-hidden>&rarr;</span>
                </button>
              </div>

              {/* Error — prominent pill so it can't be missed */}
              {urlError && (
                <div
                  id="url-error"
                  role="alert"
                  aria-live="polite"
                  className="mb-4 inline-flex items-center gap-2 rounded-input bg-brand-red/10 px-3 py-2 text-[13px] font-semibold text-brand-red"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  Please paste a valid Airbnb listing URL (starts with airbnb.com/&hellip;)
                </div>
              )}

              {/* Helper */}
              <div className="flex items-center justify-center gap-4 text-[13px] text-brand-grey400">
                <span>100% free&nbsp;&mdash; no card required</span>
                <span>&middot;</span>
                <a
                  href="/sample"
                  className="font-medium text-brand-teal hover:text-brand-tealDark"
                >
                  See a sample report
                </a>
              </div>

              {/* Escape hatch — for visitors without their Airbnb URL to hand
               * (most Meta-ad mobile traffic). Captures email + fires a
               * transactional "here's your link" email via /api/later-link. */}
              <div className="mt-4 text-[13px] text-brand-grey600">
                Don&apos;t have your listing URL handy?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setLaterSent(false);
                    setLaterError(false);
                    setShowLaterModal(true);
                  }}
                  className="font-semibold text-brand-teal underline-offset-2 hover:text-brand-tealDark hover:underline"
                >
                  Email me a link to finish later &rarr;
                </button>
              </div>

              {/* ── Testimonial card — social proof at the decision point ── */}
              <div className="mx-auto mt-8 flex max-w-[560px] items-center gap-4 rounded-card bg-white/85 p-4 text-left shadow-card backdrop-blur-sm max-sm:flex-col max-sm:gap-3 max-sm:text-center">
                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-brand-teal text-[18px] font-bold text-white">
                  A
                </div>
                <div className="flex-1">
                  <div className="mb-1 flex items-center gap-0.5 text-[13px] text-[#F5B042] max-sm:justify-center">
                    <span aria-hidden>★★★★★</span>
                    <span className="sr-only">5 out of 5 stars</span>
                  </div>
                  <p className="font-serif text-[15px] leading-snug text-brand-dark">
                    &ldquo;It has improved my life. I was just guessing at what
                    guests wanted &mdash; now I know exactly what to change.&rdquo;
                  </p>
                  <div className="mt-1.5 text-[11px] text-brand-grey400">
                    <span className="font-semibold text-brand-grey600">Alex</span>
                    &nbsp;&middot;&nbsp;Airbnb host &amp; Hello Hosty customer
                  </div>
                </div>
              </div>

              {/* Trust strip */}
              <div className="mt-10 flex flex-wrap justify-center gap-10 max-sm:gap-5">
                <TrustItem
                  icon={
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  }
                  text="Secure & private"
                />
                <TrustItem
                  icon={
                    <>
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </>
                  }
                  text="Report in seconds"
                />
                <TrustItem
                  icon={
                    <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
                  }
                  text="Copy-paste ready"
                />
              </div>

              {/* Scroll hint — nudge visitors to the proof section below */}
              <div className="mt-10 text-center">
                <a
                  href="#what-you-get"
                  className="inline-flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.14em] text-brand-grey400 transition-colors hover:text-brand-tealDark"
                >
                  See what&apos;s in the report
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </a>
              </div>
            </div>
          </section>

          {/* ════════════════════ PROOF: WHAT YOU GET ════════════════════ */}
          <section
            id="what-you-get"
            className="relative border-t border-brand-grey200 bg-brand-mist px-6 py-16 sm:py-20"
          >
            <div className="mx-auto max-w-[1080px]">
              <div className="text-center">
                <p className="text-[12px] font-bold uppercase tracking-[0.18em] text-brand-teal">
                  What you get
                </p>
                <h2 className="mx-auto mt-3 max-w-[640px] font-display text-[clamp(26px,3.4vw,40px)] leading-tight text-brand-dark">
                  A pro-grade review of your listing &mdash; free, in your
                  inbox, in under&nbsp;2&nbsp;minutes.
                </h2>
              </div>

              <div className="mt-10 grid gap-5 sm:grid-cols-3">
                <FeatureCard
                  title="Listing score"
                  body="See exactly how your listing stacks up — title, photos, amenities, pricing, copy."
                  icon={
                    <>
                      <path d="M3 3v18h18" />
                      <path d="M7 15l4-4 4 4 5-5" />
                    </>
                  }
                />
                <FeatureCard
                  title="Rewritten copy"
                  body="The exact title, description and headlines — written to convert. Copy-paste ready."
                  icon={
                    <>
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                    </>
                  }
                />
                <FeatureCard
                  title="Ranked fixes"
                  body="Your top quick wins, ordered by impact. No guessing what to change first."
                  icon={
                    <>
                      <circle cx="12" cy="12" r="10" />
                      <circle cx="12" cy="12" r="6" />
                      <circle cx="12" cy="12" r="2" />
                    </>
                  }
                />
              </div>

              <div className="mt-12 text-center">
                <a
                  href="/sample"
                  className="inline-flex items-center gap-2 rounded-input border-2 border-brand-dark bg-white px-6 py-3 text-sm font-semibold text-brand-dark transition-colors hover:bg-brand-dark hover:text-white"
                >
                  See a live sample report
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </a>
              </div>
            </div>
          </section>

          {/* ════════════════════ FAQ MINI ════════════════════ */}
          <section className="px-6 py-16 sm:py-20">
            <div className="mx-auto max-w-3xl">
              <div className="text-center">
                <p className="text-[12px] font-bold uppercase tracking-[0.18em] text-brand-teal">
                  Things hosts ask
                </p>
                <h2 className="mt-3 font-display text-[clamp(24px,3vw,34px)] leading-tight text-brand-dark">
                  A few practical questions
                </h2>
              </div>
              <div className="mt-8 rounded-card bg-white p-6 shadow-card sm:p-8">
                <FaqItem
                  q="Is the first review actually free?"
                  a="Yes — your first listing review is completely free. No card, no account. We ask for your email so we can send the PDF; that's the only string attached."
                />
                <FaqItem
                  q="Do I need to connect my Airbnb account?"
                  a="No. We work entirely from your public listing URL, the same way a guest browsing Airbnb would see it."
                />
                <FaqItem
                  q="How long does it take?"
                  a="Paste the URL, give us your email, and the report lands in your inbox in under 2 minutes."
                />
                <FaqItem
                  q="Is my listing or guest data shared?"
                  a="No. We analyse your public listing to generate your report — we don't resell, republish, or share it with anyone else."
                  last
                />
              </div>
              <p className="mt-6 text-center text-[13px] text-brand-grey400">
                More questions? See the{" "}
                <a
                  href="/how-it-works"
                  className="font-medium text-brand-teal hover:text-brand-tealDark"
                >
                  full walkthrough
                </a>
                .
              </p>
            </div>
          </section>

          {/* ════════════════════ FINAL CTA ════════════════════ */}
          <section className="px-6 pb-24 pt-4">
            <div className="mx-auto max-w-4xl rounded-card bg-gradient-to-br from-brand-dark to-brand-darkMid px-8 py-14 text-center text-white sm:px-16">
              <p className="text-[12px] font-bold uppercase tracking-[0.2em] text-brand-teal">
                Ready in two minutes
              </p>
              <h2 className="mx-auto mt-3 max-w-[640px] font-display text-[clamp(28px,3.8vw,44px)] leading-tight">
                Still think it&apos;s Airbnb&apos;s fault?
              </h2>
              <p className="mx-auto mt-4 max-w-[460px] text-[15px] leading-relaxed text-white/80">
                Paste your listing and we&apos;ll show you what&apos;s actually
                dragging your bookings down &mdash; in under 60 seconds.
              </p>
              <button
                type="button"
                onClick={focusHeroInput}
                className="mt-8 inline-flex items-center gap-2 rounded-input bg-brand-red px-8 py-4 text-base font-semibold text-white transition-colors hover:bg-brand-redHover active:scale-[.98]"
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
              </button>
              <p className="mt-6 text-[12px] text-white/50">
                100% free &middot; no card required &middot; report in under 2
                minutes
              </p>
            </div>
          </section>
        </>
      )}

      {/* ════════════════════ STEP 2: EMAIL ════════════════════ */}
      {step === 2 && (
        <section className="animate-fade-up min-h-screen px-6 pb-20 pt-[120px]">
          <div className="mx-auto max-w-[480px] text-center">
            <StepsBar current={2} />

            {/* Free badge */}
            <div className="mb-5 inline-flex items-center gap-1.5 rounded-full bg-[#e8f9e8] px-3.5 py-1.5 text-xs font-semibold text-[#2a8a2a]">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Your first listing review is completely free
            </div>

            {/* Email card */}
            <div className="rounded-card bg-white p-10 text-left shadow-cardLg max-sm:px-6 max-sm:py-7">
              <h2 className="mb-2 font-serif text-[26px] font-semibold">
                Where should we send it?
              </h2>
              <p className="mb-7 text-sm leading-relaxed text-brand-grey600">
                We&apos;ll review your listing with AI and email you a
                professional PDF report&nbsp;&mdash; completely free.
              </p>

              <label className="mb-1.5 block text-[13px] font-semibold text-brand-dark">
                Email address
              </label>
              <input
                type="email"
                value={emailValue}
                onChange={(e) => {
                  setEmailValue(e.target.value);
                  if (emailError) setEmailError(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && submitEmail()}
                placeholder="e.g. sarah@example.com"
                className={`mb-1 w-full rounded-input border-[1.5px] px-4 py-3.5 font-sans text-[15px] outline-none transition-colors focus:border-brand-teal focus:shadow-[0_0_0_3px_rgba(43,181,178,.1)] ${
                  emailError ? "border-brand-red" : "border-brand-grey200"
                }`}
              />
              {emailError && (
                <p className="mb-3 text-[13px] text-brand-red">
                  Please enter a valid email address
                </p>
              )}

              <button
                onClick={submitEmail}
                disabled={emailSubmitting}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-brand-red px-10 py-4 text-base font-semibold text-white transition-colors hover:bg-brand-redHover active:scale-[.98] disabled:cursor-wait disabled:bg-brand-grey400 disabled:hover:bg-brand-grey400"
              >
                {emailSubmitting ? (
                  <>
                    <svg
                      className="h-4 w-4 animate-spin"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <circle
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeOpacity="0.3"
                        strokeWidth="3"
                      />
                      <path
                        d="M12 2a10 10 0 0 1 10 10"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                      />
                    </svg>
                    Checking your account…
                  </>
                ) : (
                  <>
                    Get my free report
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
                  </>
                )}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ════════════════════ STEP 3: AI GENERATING + CONFIRMATION ════════════════════ */}
      {step === 3 && (
        <section className="animate-fade-up min-h-screen px-6 pb-20 pt-[120px]">
          <div className="mx-auto max-w-[560px] text-center">
            <StepsBar current={3} />

            {/* Animated AI generation graphic */}
            {!genDone && (
              <div className="mb-8">
                {/* HelloHosty icon, spinning slowly inside a circle */}
                <div className="mx-auto mb-6 flex h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-white shadow-lg">
                  <div className="animate-spin-slow">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src="/hellohosty-icon-teal.png"
                      alt="Hello Hosty"
                      width={80}
                      height={80}
                      className="h-20 w-20"
                    />
                  </div>
                </div>

                <h2 className="mb-2 font-serif text-[28px] font-bold text-brand-dark">
                  Generating your report
                </h2>
                <p className="mb-8 text-sm text-brand-grey600">
                  Our AI is analysing your listing right now.
                  <br />
                  This usually takes a couple of minutes.
                </p>

                {/* Animated status ticker */}
                <div className="mx-auto mb-8 max-w-[420px] overflow-hidden rounded-card bg-white p-6 shadow-card">
                  <div className="mb-4 flex items-center gap-3 border-b border-brand-grey200 pb-3">
                    <div className="h-3 w-3 animate-pulse rounded-full bg-brand-teal" />
                    <div className="text-sm font-semibold text-brand-dark">
                      {GEN_MESSAGES[genMsgIndex]}
                    </div>
                  </div>

                  {/* Animated scan lines */}
                  <div className="flex flex-col gap-2.5">
                    <div className="scan-line" />
                    <div className="scan-line" />
                    <div className="scan-line" />
                    <div className="scan-line" />
                  </div>
                </div>

                {/* Progress timeline */}
                <div className="mx-auto max-w-[380px] rounded-card bg-white p-6 text-left shadow-card">
                  <div className="flex flex-col gap-3">
                    <TimelineItem
                      status={completedSteps >= 1 ? "done" : "active"}
                      text="Scraping listing data"
                    />
                    <TimelineItem
                      status={completedSteps >= 2 ? "done" : completedSteps >= 1 ? "active" : "pending"}
                      text="Extracting content & amenities"
                    />
                    <TimelineItem
                      status={completedSteps >= 3 ? "done" : completedSteps >= 2 ? "active" : "pending"}
                      text="AI analysing against best practices"
                    />
                    <TimelineItem
                      status={completedSteps >= 4 ? "done" : completedSteps >= 3 ? "active" : "pending"}
                      text="Writing optimised copy"
                    />
                    <TimelineItem
                      status={completedSteps >= 5 ? "done" : completedSteps >= 4 ? "active" : "pending"}
                      text="Building & sending your PDF"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Confirmation — shown after animation completes */}
            {genDone && (
              <div className="animate-fade-up">
                {/* Checkmark */}
                <div className="mx-auto mb-7 flex h-20 w-20 animate-confirm-pop items-center justify-center rounded-full bg-brand-teal">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="white"
                    strokeWidth="2.5"
                    className="h-9 w-9"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>

                <h2 className="mb-3 font-serif text-[32px] font-bold">
                  Your report is on its way
                </h2>
                <p className="mb-10 text-base leading-relaxed text-brand-grey600">
                  We&apos;ve sent your personalised listing review to{" "}
                  <span className="font-semibold text-brand-dark">
                    {session.email}
                  </span>
                  .<br />
                  Check your inbox shortly.
                </p>

                {/* Upsell banner */}
                <div className="rounded-card bg-gradient-to-br from-brand-dark to-brand-darkMid p-8 text-center text-white">
                  <h3 className="mb-2 font-serif text-xl font-semibold">
                    Want to optimise your other listings?
                  </h3>
                  <p className="mb-5 text-sm opacity-70">
                    Check out what else Hello Hosty can do for your hosting
                    business.
                  </p>
                  <a
                    href="https://hellohosty.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block rounded-input bg-brand-teal px-7 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-tealDark"
                  >
                    Explore HelloHosty
                  </a>
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}

/* ─── Small sub-components ─── */

function TrustItem({
  icon,
  text,
}: {
  icon: React.ReactNode;
  text: string;
}) {
  return (
    <div className="flex items-center gap-2.5 text-[13px] text-brand-grey400">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="h-[18px] w-[18px] text-brand-teal opacity-60"
      >
        {icon}
      </svg>
      {text}
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-card bg-white p-7 text-left shadow-card">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-brand-tealLight text-brand-tealDark">
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
      <h3 className="mb-2 font-serif text-[20px] font-semibold text-brand-dark">
        {title}
      </h3>
      <p className="text-[14px] leading-relaxed text-brand-grey600">{body}</p>
    </div>
  );
}

function FaqItem({
  q,
  a,
  last = false,
}: {
  q: string;
  a: string;
  last?: boolean;
}) {
  return (
    <div
      className={`${last ? "" : "border-b border-brand-grey200"} py-4 first:pt-0 last:pb-0`}
    >
      <h3 className="mb-1.5 font-serif text-[17px] font-semibold text-brand-dark">
        {q}
      </h3>
      <p className="text-[14px] leading-relaxed text-brand-grey600">{a}</p>
    </div>
  );
}

function TimelineItem({
  status,
  text,
}: {
  status: "done" | "active" | "pending";
  text: string;
}) {
  return (
    <div className={`flex items-center gap-3.5 text-sm transition-all duration-500 ${
      status === "done"
        ? "text-brand-teal"
        : status === "active"
          ? "text-brand-dark font-medium"
          : "text-brand-grey400"
    }`}>
      <div
        className={`flex-shrink-0 rounded-full transition-all duration-500 ${
          status === "done"
            ? "h-2.5 w-2.5 bg-brand-teal"
            : status === "active"
              ? "h-3 w-3 animate-pulse bg-brand-teal"
              : "h-2 w-2 bg-brand-grey200"
        }`}
      />
      {text}
      {status === "done" && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="ml-auto flex-shrink-0">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </div>
  );
}
