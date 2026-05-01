/**
 * POST /api/later-link
 *
 * "Email me a link to come back to" escape hatch on Step 1 of the Lucas
 * funnel. Captures an email from people who arrived on the landing page but
 * don't have their Airbnb listing URL to hand (most Meta-ad mobile traffic).
 *
 * What it does:
 *   1. Upserts the contact in Mailchimp and applies tag `lucas-paywall-later`
 *      (paid-regime chase-up audience — replaces the legacy
 *      `listing-review-later` tag, which still drives the legacy free-promise
 *      Customer Journey for grandfathered leads).
 *   2. Also applies `listing-review-lead` so the contact shows up in the same
 *      lead pool as normal step-2 email captures (consistent reporting).
 *   3. Sends an immediate transactional email via Resend containing a magic
 *      link back to the landing page with `?email=<theirs>&utm_source=finish-later`
 *      — so when the user is ready, the URL step is all that's left. Email
 *      copy reflects the paid £19 offer; no "free" promise.
 *
 * If the contact later completes a full review they pick up
 * `lucas-first-review` too.
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

/* ── Hello Hosty brand palette (locked).
 *    Mirrors `delivery/email_templates.py` and the `hellohosty-design` skill.
 *    The OLD `#2BB5B2` teal, `#1F2933` ink and `#f84455` red shipped here for
 *    several months; they are retired and must not return. */
const HH_CORAL = "#F44A5C";
const HH_TEAL = "#28B59D";
const HH_TEAL_SOFT = "#D8F0EB";
const HH_CREAM = "#F5F1E8";
const HH_INK = "#1A1A1A";
const HH_INK_SOFT = "#4A4A4A";
const HH_SURFACE = "#FFFFFF";
const HH_FONT_STACK =
  "'Mark Pro','Cabinet Grotesk','Plus Jakarta Sans',system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

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

/* ── Mailchimp: upsert + tag `lucas-paywall-later` + `listing-review-lead` ── */
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
        // `lucas-paywall-later` is the new (paid-regime) chase-up tag. The
        // legacy free-regime tag `listing-review-later` is intentionally NOT
        // applied here so we don't grandfather brand-new traffic into the
        // free path via /api/submissions' isLegacyChaseUpLead lookup.
        { name: "lucas-paywall-later", status: "active" },
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
        <title>Your Lucas link, ready whenever you are</title>
      </head>
      <body style="margin:0;padding:0;background:${HH_CREAM};font-family:${HH_FONT_STACK};color:${HH_INK};">
        <span style="display:none !important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">Your Lucas review is ready whenever you are. Paste your Airbnb URL when you've got a minute.</span>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${HH_CREAM};padding:32px 16px;">
          <tr><td align="center">
            <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:${HH_SURFACE};border-radius:16px;overflow:hidden;max-width:600px;box-shadow:0 6px 24px -8px rgba(26,26,26,0.08);">
              <tr><td style="padding:28px 32px 0 32px;font-weight:400;">
                <span style="font-family:${HH_FONT_STACK};font-size:22px;font-weight:700;color:${HH_INK};letter-spacing:-0.01em;">Hello Hosty</span>
                <span style="display:inline-block;margin-left:10px;padding:4px 10px;background:${HH_TEAL_SOFT};color:${HH_TEAL};border-radius:999px;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;vertical-align:2px;">Lucas</span>
              </td></tr>
              <tr><td style="padding:24px 32px 8px 32px;font-family:${HH_FONT_STACK};font-size:16px;line-height:1.6;color:${HH_INK};font-weight:400;">
                <h1 style="margin:0 0 16px;font-family:${HH_FONT_STACK};font-size:28px;line-height:1.15;font-weight:700;color:${HH_INK};letter-spacing:-0.01em;">Saved. Come back when you're ready.</h1>
                <p style="margin:0 0 16px;font-weight:400;">Hi there,</p>
                <p style="margin:0 0 16px;font-weight:400;">Thanks for asking us to save you a spot. Your Lucas review is ready whenever you are. We just need your Airbnb listing URL.</p>
                <p style="margin:0 0 16px;font-weight:400;">When you've got a minute, grab your listing URL from the Airbnb app or from airbnb.com, tap the button below and paste it in. £19 one off, secure Stripe checkout, then the full report lands in this inbox a couple of minutes later.</p>
                <p style="margin:24px 0;font-weight:400;text-align:center;">
                  <a href="${link}" style="display:inline-block;background:${HH_CORAL};color:${HH_SURFACE};text-decoration:none;font-family:${HH_FONT_STACK};font-weight:600;font-size:16px;padding:14px 28px;border-radius:999px;box-shadow:0 8px 16px -4px rgba(244,74,92,0.35);">
                    Paste my Airbnb URL &rarr;
                  </a>
                </p>
              </td></tr>
              <tr><td style="padding:0 32px 8px 32px;font-family:${HH_FONT_STACK};font-size:14px;line-height:1.55;color:${HH_INK};font-weight:400;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${HH_TEAL_SOFT};border-radius:12px;">
                  <tr><td style="padding:14px 18px;font-family:${HH_FONT_STACK};font-size:13px;line-height:1.55;color:${HH_INK_SOFT};font-weight:400;">
                    <span style="color:${HH_TEAL};font-weight:600;">&check;</span> &nbsp;Button not working? Copy this link instead: <a href="${link}" style="color:${HH_TEAL};word-break:break-all;text-decoration:underline;">${link}</a>
                  </td></tr>
                </table>
              </td></tr>
              <tr><td style="padding:24px 32px 32px 32px;font-family:${HH_FONT_STACK};font-size:16px;line-height:1.6;color:${HH_INK};font-weight:400;">
                <p style="margin:0;font-weight:400;">Lucas<br><span style="color:${HH_INK_SOFT};font-size:13px;">AI listing review at Hello Hosty</span></p>
              </td></tr>
              <tr><td style="background:${HH_CREAM};padding:20px 32px;font-family:${HH_FONT_STACK};font-size:12px;color:${HH_INK_SOFT};text-align:center;font-weight:400;">
                You're receiving this because you asked us to email you a link to come back to your Lucas review at lucas.hellohosty.com.<br>
                Hello Hosty &middot; <a href="mailto:lucas@hellohosty.com" style="color:${HH_INK_SOFT};">lucas@hellohosty.com</a> &middot; <a href="https://hellohosty.com" style="color:${HH_INK_SOFT};">hellohosty.com</a>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </body>
    </html>
  `;

  const text =
    `Hi there,\n\n` +
    `Thanks for asking us to save you a spot. Your Lucas review is ready whenever you are. We just need your Airbnb listing URL.\n\n` +
    `When you've got a minute, grab your listing URL from the Airbnb app or from airbnb.com, click the link below, and paste it in. £19 one off, secure Stripe checkout, then the full report lands in this inbox a couple of minutes later.\n\n` +
    `Paste my Airbnb URL: ${link}\n\n` +
    `Lucas\n` +
    `AI listing review at Hello Hosty\n`;

  try {
    const { error } = await resend.emails.send({
      from: "Lucas at HelloHosty <lucas@notify.hellohosty.com>",
      to: [toEmail],
      replyTo: "lucas@hellohosty.com",
      subject: "Your Lucas link, ready whenever you are",
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
