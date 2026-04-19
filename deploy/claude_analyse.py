"""
Lucas — Phase 2: Claude listing analysis
=========================================

Takes the scraped listing JSON from Phase 1 and produces a structured analysis
JSON (scores, quick wins, rewritten copy, friction points) by calling the
Anthropic Claude API.

Usage
-----
    # Live (requires ANTHROPIC_API_KEY)
    python claude_analyse.py path/to/scraped.json > analysis.json

    # Dry-run (deterministic mock derived from the input; no API call)
    python claude_analyse.py path/to/scraped.json --dry-run > analysis.json

Environment
-----------
    ANTHROPIC_API_KEY          required for live calls
    LUCAS_CLAUDE_MODEL         default: claude-sonnet-4-20250514
    LUCAS_CLAUDE_MAX_TOKENS    default: 8000

The analysis JSON shape is fixed by the brief and also validated by
``validate_analysis()`` so downstream PDF generation (Phase 3) can rely on it.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date
from typing import Any


DEFAULT_MODEL = os.environ.get("LUCAS_CLAUDE_MODEL", "claude-sonnet-4-20250514")
DEFAULT_MAX_TOKENS = int(os.environ.get("LUCAS_CLAUDE_MAX_TOKENS", "8000"))


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are Lucas, HelloHosty's AI Listing Optimisation Assistant.
You review short-term rental properties on Airbnb, Booking.com and VRBO and
produce crisp, specific, actionable feedback. Your voice is warm, professional
and direct — like a senior listing consultant, never generic SEO advice.

CRITICAL DATA RULES:
- Read EVERY field in the scraped JSON carefully. The listing description,
  host profile, co-host info, reviews, amenities, location, and images are
  all there — do not skip or overlook any of them.
- Use the existing listing description as the foundation for your optimised
  version. Preserve the host's voice, specific details, and unique selling
  points. Optimise and improve, never discard.
- Generate optimised copy for EVERY description field (description, space,
  guest_access, neighbourhood, getting_around) using the full set of available
  data: location info, amenities, property details, reviews, and images.
- REVIEWS ARE A CRITICAL SECTION — never skip them:
  * If the listing HAS reviews (check the "reviews" object in the scraped JSON
    for "all_reviews" and "count"), you MUST produce a detailed
    review_sentiment_summary. Discuss what guests are actually saying: recurring
    praise, recurring complaints, sentiment patterns, and any themes that emerge.
    Quote or paraphrase specific guest comments. This is one of the most valuable
    parts of the report — hosts want to know what their guests think.
  * If the listing has NO reviews (count is 0 or all_reviews is empty), you MUST
    still produce a review_sentiment_summary that explicitly addresses the absence
    of reviews: explain why this matters for booking conversion, what new hosts can
    do to earn first reviews, and how a lack of social proof affects guest trust.
    Never leave review_sentiment_summary as null or empty.
- For host_profile assessment: include ALL host details found — name, superhost
  status, years hosting, response rate, response time, AND co-host info if present.
  Note: response rate/time are Airbnb-calculated metrics — report them as context
  but NEVER recommend "add" or "improve" them as a quick win or priority improvement.

You always respond with a single JSON object and nothing else: no preamble,
no markdown code fences, no commentary."""


ANALYSIS_SCHEMA_NOTE = """Analyse the listing and return this exact JSON shape:

{
  "property_name": "string",
  "platform": "airbnb|booking|vrbo",
  "listing_url": "string",
  "review_date": "YYYY-MM-DD",
  "total_reviews": number,
  "overall_rating": number,
  "airbnb_percentile": "string or null",

  "scores": {
    "overall": 0-100,
    "content": 0-100,
    "photos": 0-100,
    "pricing": 0-100 or null if no pricing data available,
    "amenities": 0-100,
    "seo": 0-100,
    "response": 0-100 or null if no response-time data available,
    "cleanliness": number (pass through platform data, null if missing),
    "accuracy": number or null,
    "checkin": number or null,
    "communication": number or null,
    "location": number or null,
    "value": number or null
  },

  "quick_wins": [
    {
      "title": "short, action-oriented",
      "description": "2-3 sentences: what to do and why. Include the EXACT replacement text or specific action — never say 'change to something more descriptive' without providing the actual replacement.",
      "estimated_time": "e.g. 5 minutes, 1 hour",
      "expected_impact": "high|medium|low"
    }
  ],   // 3 to 5 items, ordered by impact

  "strengths": [
    "each strength with specific evidence — cite guest reviews where available (e.g. 'Multiple guests praise the rooftop terrace'), mention counts, or listing data"
  ],   // 3 to 6 items

  "friction_points": [
    "each friction point with specific evidence — cite guest reviews where available (e.g. '3 guests mention noise from the street'), or note gaps visible in the listing"
  ],   // 3 to 6 items

  "listing_quality": {
    "title": "assessment of listing title — include specific issues and what to change",
    "photos": "assessment of photo quality, hero image, gaps — mention specific photos or missing room types",
    "description": "assessment of description accuracy, completeness, tone — reference specific sections",
    "amenities": "assessment of amenities listed, gaps, highlights — name specific missing amenities",
    "host_profile": "assessment of host profile strength — note co-host info if present"
  },

  "priority_improvements": [
    { "title": "specific action", "description": "detailed explanation with the actual suggested copy or exact change to make" }
  ],   // 3 to 5 items

  "optimised_title": "improved listing title, MUST be 50 characters or fewer",
  "title_alternatives": [
    "alternative title option 1 (50 chars max)",
    "alternative title option 2 (50 chars max)",
    "alternative title option 3 (50 chars max)"
  ],

  "optimised_description": "Complete, ready-to-paste 'About this place' description. MUST be 500 characters or fewer. Start from the host's existing description — preserve their voice and specific details. Optimise, don't replace. Warm, professional, inviting. Address top friction point. Highlight genuine strengths. Include SEO-relevant keywords naturally.",
  "optimised_space": "Ready-to-paste 'The space' description. 500 characters max. Describe the physical space, rooms, layout, special features.",
  "optimised_guest_access": "Ready-to-paste 'Guest access' description. 500 characters max. Describe what guests can access, check-in process, keys.",
  "optimised_neighbourhood": "Ready-to-paste 'Neighbourhood' description. 500 characters max. Local area, nearby attractions, transport, restaurants.",
  "optimised_getting_around": "Ready-to-paste 'Getting around' description. 500 characters max. Transport links, parking, walking distances.",

  "missing_amenities": [
    {
      "amenity": "name of the amenity",
      "competitor_pct": "estimated percentage of comparable top-rated listings that include this (e.g. '87%')",
      "reason": "why adding this would help (e.g. 'appears in guest search filters, missing it costs you visibility')"
    }
  ],

  "review_sentiment_summary": "MANDATORY — never null or empty. If reviews exist: 2-3 paragraph analysis of review patterns — common themes, recurring praise, recurring complaints, specific guest quotes or paraphrases, and how sentiment has evolved if dates allow. If NO reviews exist: 1-2 paragraphs explaining the impact of having zero reviews on booking conversion and guest trust, plus actionable advice for earning first reviews."
}

Airbnb character limits (MUST be respected in all optimised copy):
  - Title: 50 characters
  - About this place (description): 500 characters
  - The space: 500 characters
  - Guest access: 500 characters
  - Neighbourhood: 500 characters
  - Getting around: 500 characters

Rules:
- ONLY recommend things the host can directly change on their listing page. DO NOT
  recommend changes to metrics that Airbnb calculates automatically, including:
  host response rate, host response time, Superhost status, review scores, or
  any other platform-computed statistic. These are outcomes, not listing edits.
  Focus quick_wins and priority_improvements on listing content the host controls:
  title, description, photos, amenities list, pricing, house rules, etc.
- Never invent review quotes. Only use evidence that actually appears in the data.
- Every recommendation must include the EXACT text to use or the EXACT action to take. Never give vague advice like "make the title more descriptive" — instead provide the actual new title.
- Keep the host's voice when rewriting — optimise, don't replace. Reference their existing description when rewriting.
- If the listing has an existing description, your optimised version MUST build on it, not discard it. Preserve unique details, personality, and specific features the host mentions.
- Scores: return null ONLY for pricing (if no price visible) and response (if no response-time data). For all other categories (content, photos, amenities, seo), you MUST provide a score based on your assessment — these can always be evaluated from the listing data.
- For guest rating breakdown fields (cleanliness, accuracy, checkin, communication, location, value): pass through the exact platform data. Return null only if the platform data genuinely does not include that field.
- Optimised copy fields: you MUST generate content for optimised_description, optimised_space, and optimised_neighbourhood whenever there is sufficient location/property data. Only return empty string for fields where you truly have no relevant information.
- listing_quality assessments: ALWAYS provide a substantive assessment for each field. Reference specific details from the scraped data. Never return an empty or generic assessment.
- Return only the JSON object. No prose before or after."""


def build_user_prompt(scraped: dict) -> str:
    """Assemble the per-listing user prompt from the scraped JSON."""
    property_name = (scraped.get("property") or {}).get("name") or "Unknown listing"
    url = scraped.get("url", "")
    platform = scraped.get("platform", "airbnb")

    # Compact the scraped JSON; Claude handles large blobs fine and truncating
    # risks removing review evidence it needs to cite.
    scraped_blob = json.dumps(scraped, ensure_ascii=False, indent=2)

    return (
        f"PLATFORM: {platform}\n"
        f"LISTING URL: {url}\n"
        f"PROPERTY NAME: {property_name}\n"
        f"REVIEW DATE: {date.today().isoformat()}\n\n"
        "LISTING DATA (full scraped JSON, includes all reviews):\n"
        f"{scraped_blob}\n\n"
        + ANALYSIS_SCHEMA_NOTE
    )


# ---------------------------------------------------------------------------
# Live API call
# ---------------------------------------------------------------------------

def call_claude(scraped: dict, *, model: str = DEFAULT_MODEL,
                max_tokens: int = DEFAULT_MAX_TOKENS) -> dict:
    """Call Anthropic's API and return the parsed analysis JSON."""
    try:
        import anthropic
    except ImportError as e:
        raise RuntimeError(
            "The `anthropic` package is not installed. Add it to requirements "
            "and run `pip install anthropic`."
        ) from e

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY is not set. Export it, or run with --dry-run."
        )

    client = anthropic.Anthropic(api_key=api_key)
    user_prompt = build_user_prompt(scraped)

    resp = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )

    # Extract text from the content blocks.
    raw = "".join(
        block.text for block in resp.content if getattr(block, "type", None) == "text"
    ).strip()

    # Be forgiving about stray code fences, even though the prompt forbids them.
    if raw.startswith("```"):
        raw = raw.strip("`")
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw
        if raw.endswith("```"):
            raw = raw[:-3]

    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"Claude did not return valid JSON. First 400 chars:\n{raw[:400]}"
        ) from e


# ---------------------------------------------------------------------------
# Dry-run: deterministic mock analysis derived from the scraped data
# ---------------------------------------------------------------------------

def dry_run_analysis(scraped: dict) -> dict:
    """Return a structurally-complete mock analysis, populated from the scraped
    listing where possible. Intended for local development of Phase 3 (PDF)
    without burning API credit."""
    prop = scraped.get("property") or {}
    host = scraped.get("host") or {}
    content = scraped.get("content") or {}
    reviews = scraped.get("reviews") or {}
    pricing = scraped.get("pricing") or {}
    breakdown = reviews.get("breakdown") or {}
    all_reviews = reviews.get("all_reviews") or []
    amenities = scraped.get("amenities") or []

    name = prop.get("name") or content.get("title") or "this listing"
    title = content.get("title") or name

    def _score(rating):
        if not isinstance(rating, (int, float)):
            return None
        return round(min(100, max(0, rating * 20)))

    overall_rating = reviews.get("average_rating")
    base = _score(overall_rating) or 72

    missing = [a for a in [
        "Dedicated workspace", "Air conditioning", "Pack 'n play",
        "High chair", "Bathtub", "Pool", "EV charger",
    ] if a not in amenities][:4]

    # Pull 2 short phrases from actual reviews (no invention).
    def _pick_phrase(keywords, default):
        for r in all_reviews:
            txt = (r.get("text") or "").lower()
            if any(k in txt for k in keywords):
                return (r.get("text") or "")[:160]
        return default

    strengths_phrase = _pick_phrase(["love", "perfect", "amazing", "lovely"], None)
    friction_phrase = _pick_phrase(["but", "however", "wish", "issue", "problem"], None)

    analysis = {
        "property_name": name,
        "platform": scraped.get("platform", "airbnb"),
        "listing_url": scraped.get("url", ""),
        "review_date": date.today().isoformat(),
        "total_reviews": reviews.get("count"),
        "overall_rating": overall_rating,
        "airbnb_percentile": None,

        "scores": {
            "overall": base,
            "content": max(40, base - 8),
            "photos": max(40, base - 5),
            "pricing": max(40, base - 12) if (pricing.get("nightly_base") or 0) > 120 else base,
            "amenities": max(40, base - (4 * len(missing))),
            "seo": max(40, base - 10),
            "response": 95 if host.get("superhost") else 70,
            "cleanliness": breakdown.get("cleanliness"),
            "accuracy": breakdown.get("accuracy"),
            "checkin": breakdown.get("checkin"),
            "communication": breakdown.get("communication"),
            "location": breakdown.get("location"),
            "value": breakdown.get("value"),
        },

        "quick_wins": [
            {
                "title": "Lead the title with a scannable hook",
                "description": (
                    f"Your current title '{title}' reads more like a description than a hook. "
                    "Try a format like '[Style] [Key feature] in [Neighbourhood]' — easier to scan in search."
                ),
                "estimated_time": "10 minutes",
                "expected_impact": "high",
            },
            {
                "title": "Add a first-person note from the host",
                "description": (
                    f"Guests respond to warmth. Add a short opening line in {host.get('name') or 'your'}'s voice "
                    "explaining what makes this place yours. Even 2 sentences lifts conversion."
                ),
                "estimated_time": "15 minutes",
                "expected_impact": "medium",
            },
            {
                "title": "List the amenities guests assume but can't see",
                "description": (
                    "Add any of the following that you have but haven't listed: "
                    + (", ".join(missing) if missing else "iron, hangers, hair dryer, first aid kit")
                    + ". Unlisted-but-present amenities cost you search filters."
                ),
                "estimated_time": "5 minutes",
                "expected_impact": "high",
            },
            {
                "title": "Acknowledge the one recurring friction point",
                "description": (
                    "Add a short 'Good to know' line addressing "
                    + (friction_phrase[:80] + '…' if friction_phrase else "any common concern guests raise")
                    + ". Pre-empting concerns reduces 3★ and 4★ reviews."
                ),
                "estimated_time": "10 minutes",
                "expected_impact": "medium",
            },
        ],

        "strengths": [
            f"Host responsiveness — {reviews.get('count', 'multiple')} reviews cite quick replies and Superhost status"
            if host.get("superhost") else "Consistent positive feedback on host communication",
            f"Location appreciated — guests mention '{(scraped.get('location') or {}).get('neighbourhood') or 'the area'}' repeatedly",
            "Cleanliness consistently scored above the overall rating" if (breakdown.get("cleanliness") or 0) >= (overall_rating or 0)
                else "Clear, honest description that guests say matched reality",
        ],

        "friction_points": [
            "Value-for-money scores the lowest of the category breakdown — worth a pricing review"
            if (breakdown.get("value") or 5) < (overall_rating or 5) else "Pricing appears well calibrated",
            (friction_phrase[:180] if friction_phrase else
             "Review mentions of minor issues (e.g. WiFi, appliances) that could be addressed with a short 'Good to know' section"),
            "Amenities list appears under-populated vs comparable top listings in the area",
        ],

        "listing_quality": {
            "title": f"'{title}' is functional but descriptive rather than evocative. A stronger title format would lift CTR in search.",
            "photos": f"{(scraped.get('images') or {}).get('total_photos', 'Unknown number of')} photos scraped. Hero image drives search click-through; audit it for brightness, composition, and whether it telegraphs the key selling point.",
            "description": "Description covers the basics; would benefit from a stronger opening hook and explicit mentions of nearby points of interest.",
            "amenities": f"{len(amenities)} amenities listed. Missing items that top comparable listings include: " + (", ".join(missing) if missing else "review category-by-category for gaps"),
            "host_profile": f"Host profile shows {'Superhost status' if host.get('superhost') else 'standard host status'}" + (f", {host.get('years_hosting')} years hosting, response rate {host.get('response_rate')}." if host.get("years_hosting") else "."),
        },

        "priority_improvements": [
            {
                "title": "Rewrite the listing title for search + scan",
                "description": "See 'optimised_title' below for a ready-to-paste replacement. Target 50 chars or fewer; lead with the standout feature.",
            },
            {
                "title": "Restructure the description around guest jobs-to-be-done",
                "description": "Open with the 'why this place', then practicals, then area, then house rules. See 'optimised_description'.",
            },
            {
                "title": "Fill the amenities gaps",
                "description": "Add: " + (", ".join(missing) if missing else "confirm you've listed every amenity you actually provide"),
            },
        ],

        "optimised_title": (title[:47] + "...") if len(title) > 50 else title,
        "title_alternatives": [
            (title[:47] + "...") if len(title) > 50 else title,
            f"{(scraped.get('location') or {}).get('neighbourhood') or 'Central'} · {prop.get('bedrooms') or 2}-Bed · {prop.get('property_type') or 'Apartment'}"[:50],
            f"Stylish {prop.get('bedrooms') or 2}-Bed in {(scraped.get('location') or {}).get('neighbourhood') or 'the City'}"[:50],
        ],
        "optimised_description": (content.get("description") or "").strip() or
            f"Welcome to {name}. A bright, easy-to-love home designed for guests who want somewhere that just works.",
        "optimised_space": content.get("space") or "",
        "optimised_guest_access": content.get("guest_access") or "",
        "optimised_neighbourhood": "",
        "optimised_getting_around": "",
        "missing_amenities": [
            {"amenity": a, "competitor_pct": "75%",
             "reason": "Common in comparable top-rated listings"}
            for a in missing
        ],
        "review_sentiment_summary": (
            (
                f"Across {len(all_reviews)} extracted reviews, the dominant pattern is positive sentiment "
                f"around host responsiveness and location. "
                + ("The most consistent friction involves small practical issues rather than structural concerns. "
                   if friction_phrase else "")
                + "Sentiment appears stable across recent months.\n\n"
                + (f"Example of praise: \"{strengths_phrase[:140]}…\"\n" if strengths_phrase else "")
                + (f"Example of friction: \"{friction_phrase[:140]}…\"" if friction_phrase else "")
            ).strip()
            if all_reviews else
            "This listing currently has no guest reviews. For new listings, the absence of social proof "
            "is the single biggest barrier to booking conversion — most guests filter or skip unreviewed "
            "properties. Focus on competitive introductory pricing to attract your first 3-5 bookings, "
            "then follow up with a warm, personal message encouraging guests to share their experience.\n\n"
            "Once reviews start arriving, they become your most powerful marketing asset. Even a handful "
            "of detailed, positive reviews can dramatically improve your search ranking and conversion rate."
        ),
    }
    return analysis


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

REQUIRED_TOP_KEYS = {
    "property_name", "platform", "listing_url", "review_date", "total_reviews",
    "overall_rating", "scores", "quick_wins", "strengths", "friction_points",
    "listing_quality", "priority_improvements", "optimised_title",
    "title_alternatives", "optimised_description", "missing_amenities",
    "review_sentiment_summary",
}
REQUIRED_SCORE_KEYS = {
    "overall", "content", "photos", "pricing", "amenities", "seo", "response",
    "cleanliness", "accuracy", "checkin", "communication", "location", "value",
}
REQUIRED_QW_KEYS = {"title", "description", "estimated_time", "expected_impact"}
REQUIRED_LQ_KEYS = {"title", "photos", "description", "amenities", "host_profile"}


def validate_analysis(analysis: dict) -> list[str]:
    """Return a list of human-readable validation errors (empty = valid)."""
    errs: list[str] = []
    missing_top = REQUIRED_TOP_KEYS - set(analysis.keys())
    if missing_top:
        errs.append(f"missing top-level keys: {sorted(missing_top)}")

    scores = analysis.get("scores") or {}
    missing_scores = REQUIRED_SCORE_KEYS - set(scores.keys())
    if missing_scores:
        errs.append(f"missing scores keys: {sorted(missing_scores)}")

    qw = analysis.get("quick_wins") or []
    if not (3 <= len(qw) <= 5):
        errs.append(f"quick_wins should have 3-5 items, got {len(qw)}")
    for i, item in enumerate(qw):
        missing = REQUIRED_QW_KEYS - set((item or {}).keys())
        if missing:
            errs.append(f"quick_wins[{i}] missing: {sorted(missing)}")

    lq = analysis.get("listing_quality") or {}
    missing_lq = REQUIRED_LQ_KEYS - set(lq.keys())
    if missing_lq:
        errs.append(f"listing_quality missing: {sorted(missing_lq)}")

    return errs


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Run Lucas's Claude analysis on a scraped listing.")
    ap.add_argument("scraped_json", help="Path to the Phase 1 scraped JSON file, or '-' for stdin.")
    ap.add_argument("--dry-run", action="store_true", help="Skip the API and emit a mock analysis.")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--max-tokens", type=int, default=DEFAULT_MAX_TOKENS)
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args(argv)

    try:
        if args.scraped_json == "-":
            scraped = json.load(sys.stdin)
        else:
            with open(args.scraped_json, encoding="utf-8") as f:
                scraped = json.load(f)
    except Exception as e:
        print(json.dumps({"status": "error", "message": f"Could not read scraped JSON: {e}"}))
        return 1

    if scraped.get("status") and scraped["status"] != "success":
        print(json.dumps({"status": "error",
                          "message": "Scraped input has status != success; refusing to analyse.",
                          "upstream": scraped}))
        return 1

    try:
        if args.dry_run:
            analysis = dry_run_analysis(scraped)
        else:
            analysis = call_claude(scraped, model=args.model, max_tokens=args.max_tokens)
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
        return 1

    errs = validate_analysis(analysis)
    if errs:
        print(json.dumps({"status": "error",
                          "message": "Analysis failed schema validation.",
                          "errors": errs,
                          "analysis": analysis}))
        return 1

    out = {"status": "success", "analysis": analysis}
    print(json.dumps(out, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
