import type { Metadata } from "next";
import { DM_Sans, Fraunces } from "next/font/google";
import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Free AI Listing Review | Hello Hosty",
  description:
    "Hello Hosty reviews your Airbnb listing and delivers a free professional report with scores, quick wins, and ready-to-paste optimised copy — in seconds.",
  icons: {
    icon: "/icon.png",
    apple: "/apple-icon.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en-GB" className={`${dmSans.variable} ${fraunces.variable}`}>
      <body className="min-h-screen bg-brand-mist font-sans text-brand-dark antialiased">
        {children}
      </body>
    </html>
  );
}
