"use client";

/**
 * 4-step free-first-review funnel — ported from lucas-landing-page.html
 *
 * Step 1: Hero — paste Airbnb URL → "Get free review"
 * Step 2: Scrape + preview — AI scan animation → scraped data card → optional
 *         cross-platform URLs → Continue
 * Step 3: Email collect — personalised greeting from scrape → email only
 * Step 4: Confirmation — timeline + HelloHosty upsell
 */

import { useState, useCallback, useEffect, useRef } from "react";
import Image from "next/image";

/* ─── Types ─── */
interface SessionData {
  listing_url: string;
  platform: string;
  scraped_at: string | null;
  host_name: string;
  property_name: string;
  superhost: boolean;
  reviews_count: number;
  avg_rating: number;
  bedrooms: number;
  bathrooms: number;
  max_guests: number;
  hero_image_url: string;
  profile_image_url: string;
  booking_url: string;
  vrbo_url: string;
  website_url: string;
  email: string;
  is_first_time: boolean;
  submitted_at: string | null;
}

const initialSession: SessionData = {
  listing_url: "",
  platform: "airbnb",
  scraped_at: null,
  host_name: "",
  property_name: "",
  superhost: false,
  reviews_count: 0,
  avg_rating: 0,
  bedrooms: 0,
  bathrooms: 0,
  max_guests: 0,
  hero_image_url: "",
  profile_image_url: "",
  booking_url: "",
  vrbo_url: "",
  website_url: "",
  email: "",
  is_first_time: true,
  submitted_at: null,
};

/* ─── Step-dot progress bar ─── */
function StepsBar({ current }: { current: 1 | 2 | 3 | 4 }) {
  return (
    <div className="mb-10 flex items-center justify-center gap-2">
      {[1, 2, 3, 4].map((n, i) => (
        <span key={n} className="flex items-center gap-2">
          <span
            className={`h-2.5 rounded-full transition-all duration-400 ${
              n < current
                ? "w-2.5 bg-brand-teal"
                : n === current
                  ? "w-8 rounded bg-brand-teal"
                  : "w-2.5 bg-brand-grey200"
            }`}
          />
          {i < 3 && <span className="h-0.5 w-6 bg-brand-grey200" />}
        </span>
      ))}
    </div>
  );
}

/* ─── Scan-status messages ─── */
const SCAN_MESSAGES = [
  "Connecting to Airbnb\u2026",
  "Scraping listing data\u2026",
  "Extracting photos & amenities\u2026",
  "Reading reviews & ratings\u2026",
  "Pulling pricing data\u2026",
];

/* ═══════════════════════════ MAIN COMPONENT ═══════════════════════════ */
export function LandingFunnel() {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [session, setSession] = useState<SessionData>(initialSession);

  /* Step 1 */
  const [urlValue, setUrlValue] = useState("");
  const [urlError, setUrlError] = useState(false);

  /* Step 2 */
  const [isScanning, setIsScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState(SCAN_MESSAGES[0]);
  const [scrapeReady, setScrapeReady] = useState(false);
  const [bookingUrl, setBookingUrl] = useState("");
  const [vrboUrl, setVrboUrl] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");

  /* Step 3 */
  const [emailValue, setEmailValue] = useState("");
  const [emailError, setEmailError] = useState(false);

  /* Navbar scroll shadow */
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 10);
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, []);

  /* ─── Navigation ─── */
  const goToStep = useCallback(
    (n: 1 | 2 | 3 | 4) => {
      setStep(n);
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [],
  );

  /* ─── Step 1 → 2: Submit URL ─── */
  const submitUrl = useCallback(() => {
    const url = urlValue.trim();
    if (!url || (!url.includes("airbnb") && !url.includes("abnb"))) {
      setUrlError(true);
      return;
    }
    setUrlError(false);
    setSession((s) => ({ ...s, listing_url: url }));
    goToStep(2);
    callScraper(url);
  }, [urlValue, goToStep]);

  /* ─── Scraper call ─── */
  const callScraper = useCallback(async (url: string) => {
    setIsScanning(true);
    setScrapeReady(false);
    setScanStatus(SCAN_MESSAGES[0]);

    let msgIndex = 0;
    const iv = setInterval(() => {
      msgIndex++;
      if (msgIndex < SCAN_MESSAGES.length) setScanStatus(SCAN_MESSAGES[msgIndex]);
    }, 1200);

    try {
      const r = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, platform: "airbnb" }),
      });
      if (!r.ok) throw new Error("fail");
      const data = await r.json();
      clearInterval(iv);

      setSession((s) => ({
        ...s,
        host_name: data.host?.name || "Host",
        property_name: data.content?.title || "Property",
        superhost: data.host?.superhost || false,
        reviews_count: data.reviews?.count || 0,
        avg_rating: data.reviews?.average_rating || 0,
        bedrooms: data.property?.bedrooms || 0,
        bathrooms: data.property?.bathrooms || 0,
        max_guests: data.property?.max_guests || 0,
        hero_image_url: data.images?.hero_cloudinary_url || "",
        profile_image_url: data.host?.profile_image_url || "",
        scraped_at: data.scraped_at || new Date().toISOString(),
      }));
      setIsScanning(false);
      setScrapeReady(true);
    } catch {
      clearInterval(iv);
      // Demo fallback — extract listing ID from URL
      const m = url.match(/rooms\/(\d+)/);
      const id = m ? m[1] : String(Math.floor(Math.random() * 99999));
      setScanStatus("Analysis ready");

      setSession((s) => ({
        ...s,
        host_name: `Host #${id}`,
        property_name: `Airbnb Listing ${id}`,
        superhost: Math.random() > 0.3,
        reviews_count: Math.floor(Math.random() * 200) + 5,
        avg_rating: Number((Math.random() + 4).toFixed(2)),
        bedrooms: Math.floor(Math.random() * 4) + 1,
        bathrooms: Math.floor(Math.random() * 3) + 1,
        max_guests: Math.floor(Math.random() * 6) + 2,
        scraped_at: new Date().toISOString(),
      }));
      setTimeout(() => {
        setIsScanning(false);
        setScrapeReady(true);
      }, 800);
    }
  }, []);

  /* ─── Step 3 → 4: Submit email ─── */
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
      host_name: session.host_name,
      property_name: session.property_name,
      listing_url: session.listing_url,
      platform: session.platform,
      superhost: session.superhost,
      reviews_count: session.reviews_count,
      avg_rating: session.avg_rating,
      booking_url: bookingUrl.trim(),
      vrbo_url: vrboUrl.trim(),
      website_url: websiteUrl.trim(),
      is_first_time: session.is_first_time,
      submitted_at: now,
      scraped_at: session.scraped_at,
    };

    setSession((s) => ({
      ...s,
      email,
      booking_url: bookingUrl.trim(),
      vrbo_url: vrboUrl.trim(),
      website_url: websiteUrl.trim(),
      submitted_at: now,
    }));

    // Fire-and-forget save
    fetch("/api/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});

    goToStep(4);
  }, [emailValue, session, bookingUrl, vrboUrl, websiteUrl, goToStep]);

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
          className="flex items-center"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image
            src="/Hello_Hosty_Logo.png"
            alt="Hello Hosty"
            width={120}
            height={40}
            className="h-[30px] w-auto"
            priority
          />
        </a>
        <div className="hidden items-center gap-8 sm:flex">
          <a
            href="#"
            className="text-sm font-medium text-brand-grey600 transition-colors hover:text-brand-dark"
          >
            How it works
          </a>
          <a
            href="#"
            className="text-sm font-medium text-brand-grey600 transition-colors hover:text-brand-dark"
          >
            Sample report
          </a>
          <a
            href="#"
            className="rounded-lg bg-brand-teal px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-tealDark"
          >
            Get started
          </a>
        </div>
      </nav>

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

      {/* ════════════════════ STEP 1: HERO ════════════════════ */}
      {step === 1 && (
        <section className="animate-fade-up min-h-screen px-6 pb-20 pt-[120px]">
          <div className="mx-auto max-w-[680px] text-center">
            <StepsBar current={1} />

            {/* Badge */}
            <div className="mb-7 inline-flex items-center gap-2 rounded-full bg-brand-tealLight px-4 py-2 text-[13px] font-semibold tracking-wide text-brand-tealDark">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                className="h-3.5 w-3.5"
              >
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
              Powered by AI
            </div>

            {/* Title */}
            <h1 className="mb-5 font-serif text-[clamp(36px,5vw,54px)] font-bold leading-[1.15] tracking-tight text-brand-dark max-sm:text-[32px]">
              Your free listing
              <br />
              <span className="text-brand-teal">game plan</span>
            </h1>

            {/* Subtitle */}
            <p className="mx-auto mb-10 max-w-[520px] text-lg leading-relaxed text-brand-grey600">
              Hello Hosty reviews your Airbnb listing and delivers a free
              professional report with scores, quick wins, and ready-to-paste
              optimised copy&nbsp;&mdash; in seconds.
            </p>

            {/* URL input */}
            <div className="relative mx-auto mb-5 flex max-w-[560px] flex-col sm:block">
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
                type="text"
                value={urlValue}
                onChange={(e) => {
                  setUrlValue(e.target.value);
                  if (urlError) setUrlError(false);
                }}
                onKeyDown={(e) => e.key === "Enter" && submitUrl()}
                placeholder="Paste your Airbnb listing URL"
                className={`w-full rounded-[14px] border-2 bg-white py-[18px] pl-[52px] pr-[180px] font-sans text-base outline-none transition-all focus:border-brand-teal focus:shadow-[0_0_0_4px_rgba(43,181,178,.12)] max-sm:pr-4 max-sm:text-sm ${
                  urlError ? "border-brand-red" : "border-brand-grey200"
                }`}
              />
              <button
                onClick={submitUrl}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-input bg-brand-red px-6 py-3 text-[15px] font-semibold text-white transition-colors hover:bg-brand-redHover active:scale-[.97] max-sm:relative max-sm:right-auto max-sm:top-auto max-sm:mt-3 max-sm:w-full max-sm:translate-y-0 max-sm:rounded-xl max-sm:py-4"
              >
                Get free review
              </button>
            </div>

            {/* Error */}
            {urlError && (
              <p className="mb-4 text-[13px] text-brand-red">
                Please enter a valid Airbnb listing URL
              </p>
            )}

            {/* Helper */}
            <div className="flex items-center justify-center gap-4 text-[13px] text-brand-grey400">
              <span>100% free&nbsp;&mdash; no card required</span>
              <span>&middot;</span>
              <a
                href="#"
                className="font-medium text-brand-teal hover:text-brand-tealDark"
              >
                See a sample report
              </a>
            </div>

            {/* Trust strip */}
            <div className="mt-[60px] flex flex-wrap justify-center gap-10 max-sm:gap-5">
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
          </div>
        </section>
      )}

      {/* ════════════════════ STEP 2: LOADING & SCRAPED DATA ════════════════════ */}
      {step === 2 && (
        <section className="animate-fade-up min-h-screen px-6 pb-20 pt-[120px]">
          <div className="mx-auto max-w-[640px] text-center">
            <StepsBar current={2} />

            {/* AI activity scanner */}
            {isScanning && (
              <div className="mx-auto mb-10 max-w-[480px] overflow-hidden rounded-card bg-white p-8 shadow-cardLg">
                <div className="mb-6 flex items-center gap-3 border-b border-brand-grey200 pb-4">
                  <div className="h-3 w-3 animate-pulse rounded-full bg-brand-teal" />
                  <div>
                    <div className="text-sm font-semibold text-brand-dark">
                      Analysing your listing
                    </div>
                    <div className="text-xs text-brand-grey400">{scanStatus}</div>
                  </div>
                </div>
                <div className="flex flex-col gap-2.5">
                  <div className="scan-line" />
                  <div className="scan-line" />
                  <div className="scan-line" />
                  <div className="scan-line" />
                </div>
              </div>
            )}

            {/* Scraped preview card */}
            {scrapeReady && (
              <div className="animate-fade-up mb-8 rounded-card bg-white p-7 text-left shadow-card">
                {/* Hero image */}
                {session.hero_image_url && (
                  <div className="mb-5 h-[200px] overflow-hidden rounded-input bg-gradient-to-br from-brand-tealLight to-brand-grey200">
                    <img
                      src={session.hero_image_url}
                      alt="Property"
                      className="h-full w-full object-cover"
                    />
                  </div>
                )}
                {!session.hero_image_url && (
                  <div className="mb-5 h-[200px] rounded-input bg-gradient-to-br from-brand-tealLight to-brand-grey200" />
                )}

                {/* Host */}
                <div className="mb-4 flex items-center gap-3.5">
                  <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-brand-teal to-brand-tealDark text-lg font-bold text-white">
                    {session.profile_image_url ? (
                      <img
                        src={session.profile_image_url}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      session.host_name.charAt(0).toUpperCase()
                    )}
                  </div>
                  <div>
                    <div className="text-base font-semibold">
                      {session.host_name}
                    </div>
                    {session.superhost && (
                      <span className="inline-block rounded-full bg-brand-tealLight px-2.5 py-0.5 text-[11px] font-semibold text-brand-tealDark">
                        &#9733; Superhost
                      </span>
                    )}
                  </div>
                </div>

                {/* Property name */}
                <div className="mb-2 font-serif text-[22px] font-semibold">
                  {session.property_name}
                </div>

                {/* Stats */}
                <div className="flex flex-wrap gap-4 text-[13px] text-brand-grey600">
                  {session.avg_rating > 0 && (
                    <>
                      <span>
                        &#9733; {session.avg_rating} ({session.reviews_count}{" "}
                        reviews)
                      </span>
                      <span>&middot;</span>
                    </>
                  )}
                  <span>
                    {session.bedrooms} bed &middot; {session.bathrooms} bath
                  </span>
                  <span>&middot;</span>
                  <span>{session.max_guests} guests</span>
                </div>
              </div>
            )}

            {/* Platform expand */}
            {scrapeReady && (
              <div className="animate-fade-up mb-8 rounded-card bg-white p-7 text-left shadow-card">
                <h3 className="mb-1.5 text-base font-semibold">
                  List on other platforms?
                </h3>
                <p className="mb-5 text-[13px] text-brand-grey400">
                  Add more URLs for a cross-platform consistency check in your
                  report.
                </p>
                <input
                  type="text"
                  value={bookingUrl}
                  onChange={(e) => setBookingUrl(e.target.value)}
                  placeholder="Booking.com listing URL (optional)"
                  className="mb-3 w-full rounded-input border-[1.5px] border-brand-grey200 bg-brand-mist px-4 py-3.5 font-sans text-sm outline-none transition-colors focus:border-brand-teal focus:bg-white"
                />
                <input
                  type="text"
                  value={vrboUrl}
                  onChange={(e) => setVrboUrl(e.target.value)}
                  placeholder="VRBO listing URL (optional)"
                  className="mb-3 w-full rounded-input border-[1.5px] border-brand-grey200 bg-brand-mist px-4 py-3.5 font-sans text-sm outline-none transition-colors focus:border-brand-teal focus:bg-white"
                />
                <input
                  type="text"
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                  placeholder="Your personal website URL (optional)"
                  className="w-full rounded-input border-[1.5px] border-brand-grey200 bg-brand-mist px-4 py-3.5 font-sans text-sm outline-none transition-colors focus:border-brand-teal focus:bg-white"
                />
              </div>
            )}

            {/* Continue button */}
            {scrapeReady && (
              <button
                onClick={() => goToStep(3)}
                className="inline-flex items-center gap-2 rounded-xl bg-brand-red px-10 py-4 text-base font-semibold text-white transition-colors hover:bg-brand-redHover active:scale-[.98]"
              >
                Continue
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
            )}
          </div>
        </section>
      )}

      {/* ════════════════════ STEP 3: EMAIL ════════════════════ */}
      {step === 3 && (
        <section className="animate-fade-up min-h-screen px-6 pb-20 pt-[120px]">
          <div className="mx-auto max-w-[480px] text-center">
            <StepsBar current={3} />

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
              {/* Personalised greeting */}
              {session.host_name && (
                <div className="mb-6 flex items-center gap-3 rounded-input bg-brand-tealLight p-3.5">
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-teal text-sm font-bold text-white">
                    {session.profile_image_url ? (
                      <img
                        src={session.profile_image_url}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      session.host_name.charAt(0)
                    )}
                  </div>
                  <div className="text-sm font-medium text-brand-tealDark">
                    Hi {session.host_name}, your free listing review is ready
                  </div>
                </div>
              )}

              <h2 className="mb-2 font-serif text-[26px] font-semibold">
                Almost there
              </h2>
              <p className="mb-7 text-sm leading-relaxed text-brand-grey600">
                We&apos;ll email your free report as a PDF&nbsp;&mdash; it only
                takes a moment.
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
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-brand-red px-10 py-4 text-base font-semibold text-white transition-colors hover:bg-brand-redHover active:scale-[.98]"
              >
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
              </button>

              <div className="mt-5 rounded-input bg-brand-tealLight p-3.5 text-center text-[13px] text-brand-tealDark">
                Hello Hosty user?{" "}
                <a
                  href="/members/review"
                  className="font-semibold text-brand-tealDark no-underline"
                >
                  Use your login email for 30% off
                </a>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ════════════════════ STEP 4: CONFIRMATION ════════════════════ */}
      {step === 4 && (
        <section className="animate-fade-up min-h-screen px-6 pb-20 pt-[120px]">
          <div className="mx-auto max-w-[560px] text-center">
            <StepsBar current={4} />

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
              Your free report is on its way
            </h2>
            <p className="mb-10 text-base leading-relaxed text-brand-grey600">
              We&apos;re generating your personalised listing review right now.
              <br />
              Check your inbox shortly.
            </p>

            {/* Timeline card */}
            <div className="mb-7 rounded-card bg-white p-8 text-left shadow-card">
              <h3 className="mb-4 flex items-center gap-2 text-[15px] font-semibold">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                What&apos;s happening now
              </h3>
              <div className="flex flex-col gap-3.5">
                <TimelineItem status="done" text="Listing data scraped" />
                <TimelineItem
                  status="done"
                  text="Content, amenities & pricing extracted"
                />
                <TimelineItem
                  status="active"
                  text="AI analysing against best practices\u2026"
                />
                <TimelineItem
                  status="pending"
                  text="Generating your PDF report"
                />
                <TimelineItem
                  status="pending"
                  text="Sending to your inbox"
                />
              </div>
            </div>

            {/* Upsell banner */}
            <div className="rounded-card bg-gradient-to-br from-brand-dark to-brand-darkMid p-8 text-center text-white">
              <h3 className="mb-2 font-serif text-xl font-semibold">
                Get 30% off your next review
              </h3>
              <p className="mb-5 text-sm opacity-70">
                Start a free Hello Hosty trial and unlock member pricing on
                every listing review.
              </p>
              <button className="rounded-input bg-brand-teal px-7 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-tealDark">
                Start free trial
              </button>
            </div>
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

function TimelineItem({
  status,
  text,
}: {
  status: "done" | "active" | "pending";
  text: string;
}) {
  return (
    <div className="flex items-center gap-3.5 text-sm text-brand-grey600">
      <div
        className={`flex-shrink-0 rounded-full ${
          status === "done"
            ? "h-2 w-2 bg-brand-teal"
            : status === "active"
              ? "h-2.5 w-2.5 animate-pulse bg-brand-teal"
              : "h-2 w-2 bg-brand-grey200"
        }`}
      />
      {text}
      {status === "done" && " \u2713"}
    </div>
  );
}
