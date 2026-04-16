export default function BuyConfirmation({
  searchParams,
}: {
  searchParams: { email?: string };
}) {
  const email = searchParams.email || "your inbox";
  return (
    <section className="mx-auto max-w-xl px-6 py-24 text-center">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-brand-tealLight">
        <span className="text-2xl text-brand-teal">&#10003;</span>
      </div>
      <h1 className="mt-6 text-3xl font-semibold leading-tight tracking-tight md:text-4xl">
        We&apos;re on it.
      </h1>
      <p className="mt-4 text-brand-dark/70">
        Your listing review is being generated and will land at{" "}
        <strong>{email}</strong> in the next few minutes. You can close this tab.
      </p>
      <p className="mt-10 text-xs text-brand-dark/60">
        Didn&apos;t arrive? Check spam, then reply to{" "}
        <a href="mailto:lucas@hellohosty.com" className="text-brand-teal">
          lucas@hellohosty.com
        </a>
        .
      </p>
    </section>
  );
}
