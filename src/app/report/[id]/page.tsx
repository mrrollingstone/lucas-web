import { Metadata } from "next";
import Image from "next/image";

/* ───── Config ───── */
const CLOUD_NAME = "dptcyvz30";
const CLOUD_FOLDER = "lucas";

/**
 * /report/[id]
 *
 * Branded PDF preview + download page. The email links here instead of
 * directly to the Cloudinary PDF – works reliably on every device.
 *
 * URL format:
 *    /report/lucas-review-53523844-1776353328-titmuss.clive
 *
 * The [id] segment is the Cloudinary public_id (without the folder prefix).
 * From it we derive:
 *    - Thumbnail:  .../image/upload/pg_1,w_800,q_auto,f_jpg/<folder>/<id>.pdf
 *    - Download:   .../image/upload/fl_attachment/<folder>/<id>.pdf
 */

interface Props {
  params: Promise<{ id: string }>;
}

function cloudUrl(id: string, transforms?: string): string {
  const t = transforms ? `${transforms}/` : "";
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${t}${CLOUD_FOLDER}/${id}.pdf`;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return {
    title: "Your Listing Review | Hello Hosty",
    description:
      "View and download your AI-powered Airbnb listing review from Hello Hosty.",
    openGraph: {
      title: "Your Listing Review | Hello Hosty",
      description:
        "AI-powered Airbnb listing review – actionable tips to boost your listing.",
      images: [cloudUrl(id, "pg_1,w_1200,h_630,c_fill,q_auto,f_jpg")],
    },
  };
}

export default async function ReportPage({ params }: Props) {
  const { id } = await params;

  const thumbnailUrl = cloudUrl(id, "pg_1,w_800,q_auto,f_jpg");
  const downloadUrl = cloudUrl(id, "fl_attachment");

  return (
    <main className="min-h-screen bg-brand-mist flex flex-col items-center px-4 py-8 sm:py-12">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <Image
          src="/Hello_Hosty_Logo.png"
          alt="Hello Hosty"
          width={44}
          height={44}
          className="rounded-lg"
        />
        <div>
          <h1 className="font-serif text-xl sm:text-2xl font-semibold text-brand-dark leading-tight">
            Your Listing Review
          </h1>
          <p className="text-brand-grey600 text-sm">
            AI-powered by Lucas at HelloHosty
          </p>
        </div>
      </div>

      {/* Card */}
      <div className="w-full max-w-lg bg-white rounded-card shadow-card overflow-hidden">
        {/* PDF thumbnail preview – page 1 */}
        <div className="relative bg-brand-grey200">
          <Image
            src={thumbnailUrl}
            alt="Review preview – page 1"
            width={800}
            height={1040}
            className="w-full h-auto"
            priority
            unoptimized
          />
          {/* Subtle gradient overlay at the bottom to hint there's more */}
          <div className="absolute bottom-0 left-0 right-0 h-20 bg-gradient-to-t from-white/90 to-transparent pointer-events-none" />
        </div>

        {/* Download button */}
        <div className="p-5 sm:p-6">
          <a
            href={downloadUrl}
            download="listing-review.pdf"
            className="flex items-center justify-center gap-2 w-full rounded-input bg-brand-red hover:bg-brand-redHover text-white font-semibold text-base py-3.5 px-6 transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download full review (PDF)
          </a>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-8 text-center space-y-3">
        <p className="text-brand-grey600 text-sm">
          Want to review your other listings?
        </p>
        <a
          href="https://lucas.hellohosty.com"
          className="inline-block text-brand-teal hover:text-brand-tealDark font-semibold text-sm transition-colors"
        >
          Get another free review ↗
        </a>
        <p className="text-brand-grey400 text-xs mt-4">
          © {new Date().getFullYear()} HelloHosty
        </p>
      </div>
    </main>
  );
}
