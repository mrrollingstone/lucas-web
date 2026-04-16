/**
 * POST /api/scrape
 *
 * Accepts { url, platform } from the landing funnel.
 * 1. Forwards to the n8n Airbnb scraper webhook
 * 2. Uploads the hero image to Cloudinary /lucas folder
 * 3. Returns the shape the frontend expects:
 *    { host, property, content, reviews, images: { hero_cloudinary_url }, scraped_at }
 *
 * Budget: 30s. n8n can be slow — we stream status messages via
 * a simple JSON response (no SSE for now; the frontend already has
 * its own timed status messages while waiting).
 */
import { NextRequest, NextResponse } from "next/server";
import { v2 as cloudinary } from "cloudinary";

/* ── Env ── */
const N8N_URL = process.env.N8N_BASE_URL;           // e.g. https://n8n.hellohosty.com
const N8N_TOKEN = process.env.N8N_WEBHOOK_TOKEN;     // shared secret header
const CLOUDINARY_CLOUD = process.env.CLOUDINARY_CLOUD_NAME || "dptcyvz30";
const CLOUDINARY_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_SECRET = process.env.CLOUDINARY_API_SECRET;

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD,
  api_key: CLOUDINARY_KEY,
  api_secret: CLOUDINARY_SECRET,
  secure: true,
});

/* ── Types matching the n8n webhook response ── */
interface N8nScrapeResult {
  host?: { name?: string; superhost?: boolean; profile_image_url?: string };
  property?: { bedrooms?: number; bathrooms?: number; max_guests?: number; name?: string };
  content?: { title?: string };
  reviews?: { count?: number; average_rating?: number };
  images?: { hero_image_url?: string };
  scraped_at?: string;
}

export async function POST(req: NextRequest) {
  let body: { url?: string; platform?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.url) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  /* ── 1. Forward to n8n scraper webhook ── */
  let scraped: N8nScrapeResult;
  try {
    if (!N8N_URL || !N8N_TOKEN) {
      throw new Error("N8N env vars not configured — falling back to demo");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 28_000); // 28s hard limit

    const res = await fetch(`${N8N_URL}/webhook/lucas/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-lucas-token": N8N_TOKEN,
      },
      body: JSON.stringify({ url: body.url, platform: body.platform || "airbnb" }),
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`n8n scrape returned ${res.status}: ${errText}`);
      throw new Error(`n8n returned ${res.status}`);
    }

    scraped = await res.json();
  } catch (err: any) {
    console.warn("Scraper unavailable, returning demo data:", err.message);
    return NextResponse.json(buildDemoResponse(body.url));
  }

  /* ── 2. Upload hero image to Cloudinary /lucas folder ── */
  let heroCloudinaryUrl = "";
  const heroSrc = scraped.images?.hero_image_url;

  if (heroSrc && CLOUDINARY_KEY && CLOUDINARY_SECRET) {
    try {
      const upload = await cloudinary.uploader.upload(heroSrc, {
        folder: "lucas",
        resource_type: "image",
        transformation: [
          { width: 1200, height: 630, crop: "fill", gravity: "auto", quality: "auto", format: "webp" },
        ],
      });
      heroCloudinaryUrl = upload.secure_url;
    } catch (err: any) {
      console.error("Cloudinary upload failed:", err.message);
      // Fall back to the raw source URL
      heroCloudinaryUrl = heroSrc;
    }
  } else if (heroSrc) {
    // Cloudinary not configured — pass through the original URL
    heroCloudinaryUrl = heroSrc;
  }

  /* ── 3. Shape the response for the frontend ── */
  return NextResponse.json({
    host: {
      name: scraped.host?.name || "Host",
      superhost: scraped.host?.superhost || false,
      profile_image_url: scraped.host?.profile_image_url || "",
    },
    property: {
      bedrooms: scraped.property?.bedrooms || 0,
      bathrooms: scraped.property?.bathrooms || 0,
      max_guests: scraped.property?.max_guests || 0,
    },
    content: {
      title: scraped.content?.title || scraped.property?.name || "Property",
    },
    reviews: {
      count: scraped.reviews?.count || 0,
      average_rating: scraped.reviews?.average_rating || 0,
    },
    images: {
      hero_cloudinary_url: heroCloudinaryUrl,
    },
    scraped_at: scraped.scraped_at || new Date().toISOString(),
  });
}

/* ── Demo fallback when n8n is not reachable ── */
function buildDemoResponse(url: string) {
  const m = url.match(/rooms\/(\d+)/);
  const id = m ? m[1] : "00000";
  const n = Number(id);
  return {
    host: {
      name: `Demo Host ${id.slice(-3)}`,
      superhost: n % 3 !== 0,
      profile_image_url: "",
    },
    property: {
      bedrooms: (n % 4) + 1,
      bathrooms: (n % 3) + 1,
      max_guests: (n % 6) + 2,
    },
    content: {
      title: `Beautiful Listing #${id}`,
    },
    reviews: {
      count: 50 + (n % 150),
      average_rating: Number((4 + (n % 100) / 100).toFixed(2)),
    },
    images: {
      hero_cloudinary_url: "",
    },
    scraped_at: new Date().toISOString(),
  };
}
