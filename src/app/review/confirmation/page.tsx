export default function Confirmation({
  searchParams,
}: {
  searchParams: { email?: string };
}) {
  const email = searchParams.email || "your inbox";
  return (
    <section className="mx-auto max-w-xl px-6 py-24 text-center">
      <div className="mx-auto w-14 h-14 rounded-full bg-brand-tealFaint grid place-items-center">
        <span className="text-brand-teal text-2xl">✓</span>
      </div>
      <h1 className="mt-6 text-3xl md:text-4xl font-semibold leading-tight tracking-tight">
        We're on it.
      </h1>
      <p className="mt-4 text-brand-ink/70">
        Your listing review is being generated and will land at <strong>{email}</strong> in
        the next few minutes. You can close this tab.
      </p>
      <p className="mt-10 text-xs text-brand-ink/60">
        Didn't arrive? Check spam, then reply to{" "}
        <a href="mailto:lucas@hellohosty.com" className="text-brand-teal">lucas@hellohosty.com</a>.
      </p>
    </section>
  );
}
