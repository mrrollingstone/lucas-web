/**
 * POST /api/submissions
 *
 * Accepts the full session payload from the landing funnel after step 3.
 * 1. Forwards to n8n webhook (which persists to Airtable or Postgres)
 * 2. Tags the email in Mailchimp with `lucas-first-review`
 * 3. Kicks off the report generation pipeline via n8n
 *
 * Env vars required:
 *   N8N_BASE_URL, N8N_WEBHOOK_TOKEN
 *   MAILCHIMP_API_KEY, MAILCHIMP_LIST_ID (audience ID)
 */
import { NextRequest, NextResponse } from "next/server";
import mailchimp from "@mailchimp/mailchimp_marketing";
import crypto from "crypto";

/* ── Env ── */
const N8N_URL = process.env.N8N_BASE_URL;
const N8N_TOKEN = process.env.N8N_WEBHOOK_TOKEN;
const MC_API_KEY = process.env.MAILCHIMP_API_KEY;
const MC_LIST_ID = process.env.MAILCHIMP_LIST_ID; // Audience / list ID
const MC_SERVER = MC_API_KEY?.split("-").pop() || "us1"; // e.g. "us21"

if (MC_API_KEY) {
  mailchimp.setConfig({ apiKey: MC_API_KEY, server: MC_SERVER });
}

/* ── Payload shape from the frontend ── */
interface SubmissionPayload {
  email: string;
  host_name: string;
  property_name: string;
  listing_url: string;
  platform: string;
  superhost: boolean;
  reviews_count: number;
  avg_rating: number;
  booking_url?: string;
  vrbo_url?: string;
  website_url?: string;
  is_first_time: boolean;
  submitted_at: string;
  scraped_at: string | null;
}

export async function POST(req: NextRequest) {
  let body: SubmissionPayload;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.email || !body.listing_url) {
    return NextResponse.json(
      { error: "Missing required fields (email, listing_url)" },
      { status: 400 },
    );
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";

  /* ── 1. Forward to n8n — stores submission + kicks off report pipeline ── */
  const n8nOk = await forwardToN8n({ ...body, ip });

  /* ── 2. Tag in Mailchimp with `lucas-first-review` ── */
  const mcOk = await tagInMailchimp(body.email, body.host_name);

  /* ── 3. Trigger drip email sequence via n8n ── */
  const dripOk = await triggerDrip(body.email, body.host_name, body.listing_url);

  console.log(
    `📋 Submission: email=${body.email} listing=${body.listing_url} n8n=${n8nOk ? "ok" : "fail"} mc=${mcOk ? "ok" : "fail"} drip=${dripOk ? "ok" : "fail"}`,
  );

  return NextResponse.json({
    ok: true,
    n8n: n8nOk ? "forwarded" : "unavailable",
    mailchimp: mcOk ? "tagged" : "unavailable",
    drip: dripOk ? "triggered" : "unavailable",
  });
}

/* ── n8n forwarding ── */
async function forwardToN8n(
  payload: SubmissionPayload & { ip: string },
): Promise<boolean> {
  if (!N8N_URL || !N8N_TOKEN) {
    console.warn("n8n not configured — skipping submission forward");
    return false;
  }
  try {
    const res = await fetch(`${N8N_URL}/webhook/lucas/new-review`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-lucas-token": N8N_TOKEN,
      },
      body: JSON.stringify({
        ...payload,
        paid: false, // Free-first-review funnel
        source: "landing-funnel-v2",
      }),
      cache: "no-store",
    });
    return res.ok;
  } catch (err: any) {
    console.error("n8n forward failed:", err.message);
    return false;
  }
}

/* ── Drip: trigger the 3-email nurture sequence via n8n ── */
async function triggerDrip(
  email: string,
  name: string,
  listingUrl: string,
): Promise<boolean> {
  if (!N8N_URL) {
    console.warn("n8n not configured — skipping drip trigger");
    return false;
  }
  try {
    const res = await fetch(`${N8N_URL}/webhook/lucas-drip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name: name || "", listingUrl }),
      cache: "no-store",
    });
    return res.ok;
  } catch (err: any) {
    console.error("Drip trigger failed:", err.message);
    return false;
  }
}

/* ── Mailchimp: upsert contact + apply tag ── */
async function tagInMailchimp(
  email: string,
  firstName: string,
): Promise<boolean> {
  if (!MC_API_KEY || !MC_LIST_ID) {
    console.warn("Mailchimp not configured — skipping tag");
    return false;
  }

  const subscriberHash = crypto
    .createHash("md5")
    .update(email.toLowerCase())
    .digest("hex");

  try {
    // Upsert the contact (add or update)
    await mailchimp.lists.setListMember(MC_LIST_ID, subscriberHash, {
      email_address: email.toLowerCase(),
      status_if_new: "subscribed" as const,
      merge_fields: {
        FNAME: firstName || "",
      },
    });

    // Apply the lucas-first-review tag
    await mailchimp.lists.updateListMemberTags(MC_LIST_ID, subscriberHash, {
      tags: [{ name: "lucas-first-review", status: "active" as const }],
    });

    return true;
  } catch (err: any) {
    console.error(
      "Mailchimp tagging failed:",
      err.response?.body?.detail || err.message,
    );
    return false;
  }
}
