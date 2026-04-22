/**
 * POST /api/later-link
 *
 * "Email me a link to finish later" escape hatch on Step 1 of the Lucas
 * funnel. Captures an email from people who arrived on the landing page but
 * don't have their Airbnb listing URL to hand (most Meta-ad mobile traffic).
 *
 * What it does:
 *   1. Upserts the contact in Mailchimp and applies tag `listing-review-later`
 *      (this tag is what triggers the chase-up Customer Journey — see memory
 *      `reference_lucas_drip_mailchimp.md`).
 *   2. Also applies `listing-review-lead` so the contact shows up in the same
 *      lead pool as normal step-2 email captures (consistent reporting).
 *   3. Sends an immediate transactional email via Resend containing a magic
 *      link back to the landing page with `?email=<theirs>&utm_source=finish-later`
 *      — so when the user is ready, the URL step is all that's left.
 *
 * If the contact later completes a full review they pick up
 * `lucas-first-review` too. The chase-up journey in Mailchimp uses that tag as
 * its exit criteria (don't nag people who've already converted).
 *
 * Env vars required:
 *   RESEND_API_KEY
 *   MAILCHIMP_API_KEY, MAILCHIMP_LIST_ID
 *   NEXT_PUBLIC_SITE_URL  (optional — defaults to https://lucas.hellohosty.com)
 */
import { NextRequest, NextResponse } from "next/server";
import mailchimp from "@mailchimp/mailchimp_marketing";
import { Resend } from "resend";
import crypto from "crypto";

/* ── Env ── */
const MC_API_KEY = process.env.MAILCHIMP_API_KEY;
const MC_LIST_ID = process.env.MAILCHIMP_LIST_ID;
const MC_SERVER = MC_API_KEY?.split("-").pop() || "us1";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || "https://lucas.hellohosty.com";

if (MC_API_KEY) {
  mailchimp.setConfig({ apiKey: MC_API_KEY, server: MC_SERVER });
}

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

/* ── Brand colours (mirrors tailwind.config + email_templates.py) ── */
const BRAND_TEAL = "#2BB5B2";
const BRAND_INK = "#1F2933";
const BRAND_RED = "#f84455";

interface LaterLinkPayload {
  email: string;
  utm_source?: string;
  utm_campaign?: string;
}

export async function POST(req: NextRequest) {
  let body: LaterLinkPayload;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@") || !email.includes(".")) {
    return NextResponse.json(
      { error: "Valid email required" },
      { status: 400 },
    );
  }

  /* ── 1. Tag in Mailchimp so the chase-up journey can pick them up ── */
  const mcOk = await tagInMailchimp(email);

  /* ── 2. Send the immediate "here's your link" email ── */
  const emailOk = await sendComeBackEmail(email, {
    utm_source: body.utm_source,
    utm_campaign: body.utm_campaign,
  });

  console.log(
    `📬 Later-link: email=${email} mc=${mcOk ? "ok" : "fail"} email=${emailOk ? "ok" : "fail"}${body.utm_source ? ` utm=${body.utm_source}` : ""}`,
  );

  return NextResponse.json({
    ok: true,
    mailchimp: mcOk ? "tagged" : "unavailable",
    email: emailOk ? "sent" : "unavailable",
  });
}

/* ── Mailchimp: upsert + tag `listing-review-later` + `listing-review-lead` ── */
async function tagInMailchimp(email: string): Promise<boolean> {
  if (!MC_API_KEY || !MC_LIST_ID) {
    console.warn("Mailchimp not configured — skipping later-link tag");
    return false;
  }

  const subscriberHash = crypto
    .createHash("md5")
    .update(email)
    .digest("hex");

  try {
    await mailchimp.lists.setListMember(MC_LIST_ID, subscriberHash, {
      email_address: email,
      status_if_new: "subscribed" as const,
      merge_fields: {},
    });

    await mailchimp.lists.updateListMemberTags(MC_LIST_ID, subscriberHash, {
      tags: [
        { name: "listing-review-later", status: "active" },
        { name: "listing-review-lead", status: "active" },
      ],
    });

    return true;
  } catch (err: any) {
    console.error(
      "Mailchimp later-link tagging failed:",
      err.response?.body?.detail || err.message,
    );
    return false;
  }
}

/* ── Resend: immediate "here's your link" transactional email ── */
async function sendComeBackEmail(
  toEmail: string,
  opts: { utm_source?: string; utm_campaign?: string },
): Promise<boolean> {
  if (!resend) {
    console.warn("Resend not configured — skipping later-link email");
    return false;
  }

  // Magic link back to the landing page — email prefilled so the only thing
  // the user needs to do when they come back is paste their listing URL.
  const qs = new URLSearchParams({
    email: toEmail,
    utm_source: "finish-later",
    utm_medium: "email",
    utm_campaign: opts.utm_campaign || "later-link-immediate",
  });
  if (opts.utm_source) qs.set("utm_source_original", opts.utm_source);
  const link = `${SITE_URL}/?${qs.toString()}`;

  const html = `
    <!doctype html>
    <html lang="en-GB">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width">
        <title>Your Lucas link — paste your Airbnb URL when you're ready</title>
      </head>
      <body style="margin:0;padding:0;background:#F2F2F2;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${BRAND_INK};">
        <span style="display:none !important;opacity:0;color:transparent;height:0;width:0;">Your Lucas listing review is 60 seconds away — paste your Airbnb URL whenever you're ready.</span>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F2F2;padding:32px 0;">
          <tr><td align="center">
            <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:560px;">
              <tr><td style="background:${BRAND_TEAL};padding:18px 28px;color:#ffffff;font-weight:700;font-size:14px;letter-spacing:0.5px;">
                HELLOHOSTY · AI LISTING REVIEW
              </td></tr>
              <tr><td style="padding:28px;font-size:15px;line-height:1.6;">
                <p style="margin:0 0 14px;color:${BRAND_TEAL};font-weight:600;">Hey there,</p>
                <p style="margin:0 0 14px;">Thanks for asking us to save you a spot. Your free AI listing review is ready whenever you are &mdash; we just need your Airbnb listing URL.</p>
                <p style="margin:0 0 22px;">When you've got a minute, grab your listing URL (from the Airbnb app or airbnb.com), tap the button below and paste it in. The report lands in this inbox roughly 60 seconds later.</p>
                <p style="margin:0 0 22px;text-align:center;">
                  <a href="${link}" style="display:inline-block;background:${BRAND_RED};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:10px;">
                    Paste my Airbnb URL &rarr;
                  </a>
                </p>
                <p style="margin:0 0 14px;font-size:13px;color:#667085;">Or copy this link: <a href="${link}" style="color:${BRAND_TEAL};word-break:break-all;">${link}</a></p>
                <p style="margin:18px 0 0;">&mdash; The HelloHosty team</p>
              </td></tr>
              <tr><td style="background:#F8FAFA;padding:18px 28px;font-size:12px;color:#667085;text-align:center;">
                You're receiving this because you asked us to email you a link to finish your free AI listing review at lucas.hellohosty.com.<br>
                HelloHosty &middot; <a href="mailto:lucas@hellohosty.com" style="color:#667085;">lucas@hellohosty.com</a> &middot; <a href="https://hellohosty.com" style="color:#667085;">hellohosty.com</a>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body>
    </html>
  `;

  const text =
    `Hey there,\n\n` +
    `Thanks for asking us to save you a spot. Your free AI listing review is ready whenever you are — we just need your Airbnb listing URL.\n\n` +
    `When you've got a minute, grab your listing URL (from the Airbnb app or airbnb.com), click the link below, and paste it in. The report lands in this inbox roughly 60 seconds later.\n\n` +
    `Paste my Airbnb URL: ${link}\n\n` +
    `— The HelloHosty team\n`;

  try {
    const { error } = await resend.emails.send({
      from: "Lucas at HelloHosty <lucas@notify.hellohosty.com>",
      to: [toEmail],
      replyTo: "lucas@hellohosty.com",
      subject: "Your Lucas link — paste your Airbnb URL when you're ready",
      html,
      text,
      headers: { "X-Entity-Ref-ID": `lucas-later-link-${Date.now()}` },
    });
    if (error) {
      console.error("Resend later-link email failed:", error);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error("Resend later-link email exception:", err.message);
    return false;
  }
}
