import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Airbnb Listing Review · HelloHosty",
  description:
    "HelloHosty reviews your short-term rental listing end-to-end and sends a branded PDF with scores, quick wins and rewritten copy — in minutes.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en-GB">
      <body className="min-h-screen bg-brand-mist text-brand-ink antialiased">
        <header className="bg-white border-b border-black/5">
          <div className="mx-auto max-w-5xl px-6 py-4 flex items-center justify-between">
            <a href="https://hellohosty.com" className="font-semibold tracking-tight">
              HelloHosty
            </a>
            <span className="text-xs font-semibold uppercase tracking-widest text-brand-teal">
              AI Listing Review
            </span>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
