"""
Lucas — Airbnb listing scraper (Phase 1)
========================================

Scrapes a public Airbnb listing page and emits structured JSON to stdout for
consumption by the n8n pipeline that powers HelloHosty's Lucas review tool.

Design notes
------------
Airbnb renders listing pages via React + hydration. Two reliable data sources
are available in-page, both of which this scraper uses defensively:

1. ``window.__NIOBE_MINIMAL_CLIENT_DATA__`` / ``niobeMinimalClientData`` —
   a JSON graph attached to a ``<script id="data-deferred-state-0">`` (or
   similar) tag. This contains the full Apollo-style response for the
   ``StaysPdpSections`` query and is the primary source of truth.
2. ``__NEXT_DATA__`` — older path, still present on some rollouts.

We prefer (1), fall back to (2), and fall back to DOM selectors only as a
last resort (selectors drift, JSON does not).

Reviews are paginated and not fully in the initial bundle. We click
"Show all reviews" programmatically, scroll the modal, and extract every
review until no new rows appear.

Usage
-----
    python scrape_airbnb.py "https://www.airbnb.co.uk/rooms/53523844"

Environment
-----------
    CLOUDINARY_CLOUD_NAME   (default: dptcyvz30)
    CLOUDINARY_API_KEY
    CLOUDINARY_API_SECRET
    CLOUDINARY_FOLDER       (default: lucas)
    LUCAS_HEADLESS          (default: 1)
    LUCAS_TIMEOUT_MS        (default: 30000)

Exit codes
----------
    0  success JSON emitted
    1  unrecoverable error (JSON with status=error still emitted to stdout)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlparse

# Third-party — imported inside main() so --help works without them installed
# (useful on fresh VPS checkouts).


# ---------------------------------------------------------------------------
# URL handling
# ---------------------------------------------------------------------------

AIRBNB_HOSTS = (
    "airbnb.com", "airbnb.co.uk", "airbnb.ca", "airbnb.com.au",
    "airbnb.ie", "airbnb.fr", "airbnb.de", "airbnb.es", "airbnb.it",
    "airbnb.nl", "airbnb.pt", "airbnb.co.nz", "airbnb.co.in",
)


def normalise_url(raw: str) -> tuple[str, str]:
    """Return (canonical_url, listing_id) or raise ValueError."""
    parsed = urlparse(raw.strip())
    host = (parsed.netloc or "").lower().lstrip("www.")
    if not any(host.endswith(h) for h in AIRBNB_HOSTS):
        raise ValueError(f"Not an Airbnb host: {host!r}")

    m = re.search(r"/rooms/(?:plus/)?(\d+)", parsed.path)
    if not m:
        raise ValueError(f"No /rooms/<id> segment in path: {parsed.path!r}")
    listing_id = m.group(1)

    # Canonicalise: strip tracking params but keep the listing id.
    canonical = f"https://{host}/rooms/{listing_id}"
    return canonical, listing_id


# ---------------------------------------------------------------------------
# Page interaction helpers
# ---------------------------------------------------------------------------

def _safe_click(page, selector: str, timeout_ms: int = 3000) -> bool:
    """Click a selector if present; swallow failures."""
    try:
        loc = page.locator(selector).first
        loc.wait_for(state="visible", timeout=timeout_ms)
        loc.click(timeout=timeout_ms)
        return True
    except Exception:
        return False


def dismiss_modals(page) -> None:
    """Close cookie/translation banners that can intercept clicks."""
    for sel in [
        "button[data-testid='accept-btn']",
        "button:has-text('Accept all')",
        "button:has-text('OK')",
        "div[role='dialog'] button[aria-label='Close']",
        "button[aria-label='Close']",
        "div[data-testid='translation-announce-modal'] button[aria-label='Close']",
    ]:
        _safe_click(page, sel, timeout_ms=1500)


def expand_amenities(page) -> None:
    """Click the 'Show all NN amenities' button and wait for the modal."""
    for sel in [
        "button:has-text('Show all')",  # generic
        "a:has-text('Show all amenities')",
        "button[data-testid='pdp-show-all-amenities-button']",
    ]:
        if _safe_click(page, sel, timeout_ms=2000):
            # Wait for the amenities modal to render.
            try:
                page.locator("div[role='dialog']").first.wait_for(
                    state="visible", timeout=4000
                )
            except Exception:
                pass
            return


def open_reviews_modal(page) -> bool:
    """Click the 'Show all reviews' button. Returns True if opened."""
    for sel in [
        "button:has-text('Show all ')",
        "a:has-text('Show all reviews')",
        "button[data-testid='pdp-show-all-reviews-button']",
    ]:
        if _safe_click(page, sel, timeout_ms=2500):
            try:
                page.locator("div[role='dialog']").first.wait_for(
                    state="visible", timeout=4000
                )
                return True
            except Exception:
                return False
    return False


def scroll_reviews_modal(
    page,
    max_rounds: int = 200,
    stagnant_limit: int = 8,
    settle_ms: int = 1100,
    expected_count: Optional[int] = None,
) -> int:
    """Scroll the reviews modal until no new reviews load (or cap reached).

    Notes
    -----
    The previous version exited far too early: 60 rounds with 3 stagnant
    rounds and a 600ms settle is enough for ~10 reviews on a fast network,
    but listings with 30+ reviews routinely stalled. Three concrete fixes:

      1. Scroll EVERY scrollable descendant, not just the first one. Airbnb
         occasionally wraps the virtualised list in two scroll containers.
      2. After setting scrollTop, dispatch a real 'scroll' event AND fire a
         wheel event — virtualised lists frequently subscribe to those rather
         than polling scrollTop.
      3. Be much more patient: 200 rounds, 8 stagnant rounds, 1.1s settle.
         A typical 50-review listing finishes in ~12 rounds; the cap exists
         only to stop runaway loops.

    If ``expected_count`` is given, we keep scrolling past stagnant rounds
    until we hit it (or burn the round budget) — this rescues the common
    case where the inner list briefly stalls between batches.
    """
    last_count = -1
    stagnant = 0
    for round_idx in range(max_rounds):
        page.evaluate(
            """
            () => {
              const dlg = document.querySelector("div[role='dialog']");
              if (!dlg) return;
              // Collect every scrollable descendant — older Airbnb rollouts
              // nested the actual virtualised scroller two layers deep.
              const scrollers = [];
              const all = dlg.querySelectorAll('*');
              for (const n of all) {
                const s = getComputedStyle(n);
                if ((s.overflowY === 'auto' || s.overflowY === 'scroll')
                    && n.scrollHeight > n.clientHeight + 4) {
                  scrollers.push(n);
                }
              }
              // Always include the dialog itself as a fallback target.
              if (!scrollers.includes(dlg)) scrollers.push(dlg);

              for (const target of scrollers) {
                const before = target.scrollTop;
                target.scrollTop = target.scrollHeight;
                // Dispatch real events — virtualised lists ignore raw
                // scrollTop assignments on some Chrome versions.
                target.dispatchEvent(new Event('scroll', { bubbles: true }));
                try {
                  target.dispatchEvent(new WheelEvent('wheel', {
                    bubbles: true, cancelable: true,
                    deltaY: Math.max(800, target.clientHeight),
                  }));
                } catch (e) { /* WheelEvent unsupported in old browsers */ }
                // If scrolling didn't advance, nudge with a small reverse
                // then forward to re-arm scroll listeners.
                if (target.scrollTop === before && target.scrollHeight > target.clientHeight) {
                  target.scrollTop = Math.max(0, before - 120);
                  target.dispatchEvent(new Event('scroll', { bubbles: true }));
                  target.scrollTop = target.scrollHeight;
                }
              }
            }
            """
        )
        # Also press End on the focused dialog — works when no scrollable
        # descendant exists (focus lives inside the modal already).
        try:
            page.keyboard.press("End")
        except Exception:
            pass
        time.sleep(settle_ms / 1000)
        count = page.evaluate(
            """() => document.querySelectorAll(
                  "div[role='dialog'] [data-review-id], "
                + "div[role='dialog'] div[aria-label^='Rating'], "
                + "div[role='dialog'] [data-testid='pdp-review-card'], "
                + "div[role='dialog'] [id^='review_'], "
                + "div[role='dialog'] [role='listitem']"
              ).length"""
        )
        if count <= last_count:
            stagnant += 1
            # If the platform tells us how many to expect and we're still
            # short by a meaningful margin, push past stagnant detection.
            if expected_count and count < expected_count and stagnant < (stagnant_limit * 2):
                continue
            if stagnant >= stagnant_limit:
                break
        else:
            stagnant = 0
            last_count = count
    print(
        f"INFO: scroll_reviews_modal finished round={round_idx + 1} "
        f"final_count={last_count} expected={expected_count}",
        file=sys.stderr,
    )
    return max(0, last_count)


# ---------------------------------------------------------------------------
# Data extraction
# ---------------------------------------------------------------------------

def extract_niobe_state(page) -> Optional[dict]:
    """Pull the deferred/Niobe client data blob. Returns a dict or None."""
    return page.evaluate(
        """
        () => {
          // Modern path: a <script> with id data-deferred-state-*
          const scripts = Array.from(document.querySelectorAll('script'));
          for (const s of scripts) {
            const id = s.id || '';
            if (id.startsWith('data-deferred-state') && s.textContent) {
              try { return JSON.parse(s.textContent); } catch (e) {}
            }
          }
          // Fallback: __NEXT_DATA__
          const nd = document.getElementById('__NEXT_DATA__');
          if (nd && nd.textContent) {
            try { return JSON.parse(nd.textContent); } catch (e) {}
          }
          return null;
        }
        """
    )


def _walk(obj: Any, predicate):
    """Yield every node in a JSON-ish tree that matches predicate."""
    if isinstance(obj, dict):
        if predicate(obj):
            yield obj
        for v in obj.values():
            yield from _walk(v, predicate)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v, predicate)


def first(iterable, default=None):
    try:
        return next(iter(iterable))
    except StopIteration:
        return default


def extract_from_niobe(state: dict) -> dict:
    """Best-effort pull of everything Lucas needs from the Niobe blob."""
    out: dict[str, Any] = {
        "property": {}, "host": {}, "content": {}, "amenities": [],
        "pricing": {}, "reviews": {}, "policies": {}, "location": {},
        "images": {},
    }

    # Title / listing name
    title_node = first(
        _walk(state, lambda d: isinstance(d.get("title"), str) and "sharingConfig" in d),
        None,
    )
    if title_node:
        out["content"]["title"] = title_node.get("title")
        out["property"]["name"] = title_node.get("title")

    # Property summary (beds/baths/guests) — usually in an overviewItems list.
    overview = first(
        _walk(state, lambda d: "overviewItems" in d and isinstance(d["overviewItems"], list)),
        None,
    )
    if overview:
        for item in overview["overviewItems"]:
            txt = (item.get("title") or "").lower()
            if "guest" in txt:
                m = re.search(r"(\d+)", txt); out["property"]["max_guests"] = int(m.group(1)) if m else None
            elif "bedroom" in txt:
                m = re.search(r"(\d+)", txt); out["property"]["bedrooms"] = int(m.group(1)) if m else None
            elif "bathroom" in txt:
                m = re.search(r"(\d+(?:\.\d+)?)", txt); out["property"]["bathrooms"] = float(m.group(1)) if m else None
            elif "bed" in txt:
                pass

    # Property type (apartment, house, etc.)
    ptype_node = first(
        _walk(state, lambda d: isinstance(d.get("roomTypeCategory"), str)
              or isinstance(d.get("propertyType"), str)
              or isinstance(d.get("pdpType"), str)),
        None,
    )
    if ptype_node:
        out["property"]["property_type"] = (
            ptype_node.get("propertyType")
            or ptype_node.get("roomTypeCategory")
            or ptype_node.get("pdpType")
        )

    # Description / space / guest access — handle multiple Airbnb schema versions
    desc_nodes = list(_walk(
        state,
        lambda d: (
            d.get("__typename") in (
                "PdpDescriptionSection", "DescriptionSection",
                "PdpDescriptionSectionV2", "PdpDescriptionSectionV3",
            )
            or ("htmlDescription" in d and isinstance(d["htmlDescription"], dict))
            or (d.get("sectionId") == "DESCRIPTION_DEFAULT" and ("body" in d or "section" in d))
            or d.get("sectionComponentType") == "DESCRIPTION"
        ),
    ))
    for node in desc_nodes:
        html = node.get("htmlDescription") or {}
        text = (
            html.get("htmlText")
            or html.get("text")
            or node.get("description")
            or ((node.get("body") or {}).get("htmlText") if isinstance(node.get("body"), dict) else None)
            or ((node.get("section") or {}).get("htmlText") if isinstance(node.get("section"), dict) else None)
            or node.get("bodyText")
            or node.get("sectionDescription")
        )
        if text and "description" not in out["content"]:
            out["content"]["description"] = _strip_html(text)

    # Extract sub-sections: The space, Guest access, Other things to note
    subsection_nodes = list(_walk(
        state,
        lambda d: (d.get("__typename") in ("PdpDescriptionSubSection", "DescriptionSubSection")
                   or (isinstance(d.get("title"), str) and isinstance(d.get("htmlDescription"), dict)
                       and d.get("title", "").lower() in (
                           "the space", "guest access", "other things to note",
                           "the neighbourhood", "getting around",
                       ))),
    ))
    section_map = {
        "the space": "space",
        "guest access": "guest_access",
        "other things to note": "other_notes",
        "the neighbourhood": "neighbourhood",
        "getting around": "getting_around",
    }
    for node in subsection_nodes:
        title_key = (node.get("title") or "").strip().lower()
        content_key = section_map.get(title_key)
        if content_key:
            html = node.get("htmlDescription") or {}
            text = html.get("htmlText") or html.get("text") or ""
            if text:
                out["content"][content_key] = _strip_html(text)

    # Amenities
    amenity_groups = list(_walk(
        state,
        lambda d: "seeAllAmenitiesGroups" in d or d.get("__typename") == "AmenitiesSection",
    ))
    amenities: list[str] = []
    for g in amenity_groups:
        groups = g.get("seeAllAmenitiesGroups") or g.get("previewAmenitiesGroups") or []
        for grp in groups:
            for a in grp.get("amenities", []) or []:
                title = a.get("title")
                if title and a.get("available", True):
                    amenities.append(title)
    out["amenities"] = sorted(set(amenities))

    # Images — extract all photo URLs and captions for analysis
    photos = list(_walk(state, lambda d: d.get("__typename") == "Photo" and d.get("baseUrl")))
    if photos:
        out["images"]["hero_image_url"] = photos[0].get("baseUrl")
        out["images"]["total_photos"] = len(photos)
        out["images"]["all_photos"] = [
            {
                "url": p.get("baseUrl"),
                "caption": p.get("caption") or p.get("accessibilityLabel") or "",
                "id": p.get("id"),
            }
            for p in photos
        ]

    # Host — comprehensive profile extraction
    host_node = first(_walk(state, lambda d: d.get("__typename") == "User" and d.get("smartName")), None)
    if host_node:
        out["host"]["name"] = host_node.get("smartName") or host_node.get("firstName")
        out["host"]["profile_image_url"] = host_node.get("pictureUrl")
        out["host"]["superhost"] = bool(host_node.get("isSuperhost"))
        if host_node.get("about"):
            out["host"]["about"] = host_node["about"]
        if host_node.get("reviewsCount"):
            out["host"]["reviews_received"] = host_node["reviewsCount"]
        if host_node.get("listingCount"):
            out["host"]["total_listings"] = host_node["listingCount"]

    # Full host profile section (contains response metrics, badges, about text)
    host_section = first(_walk(
        state,
        lambda d: d.get("__typename") in ("HostProfileSection", "PdpHostSection",
                                            "MeetYourHostSection")
        or ("hostResponseRate" in d or "hostResponseTime" in d)
    ), None)
    if host_section:
        out["host"]["response_rate"] = host_section.get("hostResponseRate")
        out["host"]["response_time"] = host_section.get("hostResponseTime")
        out["host"]["years_hosting"] = host_section.get("timeAsHost", {}).get("years") if isinstance(
            host_section.get("timeAsHost"), dict
        ) else host_section.get("hostingYears")
        # Host highlights (languages, verification badges, etc.)
        highlights = host_section.get("highlights") or host_section.get("hostHighlights") or []
        if highlights:
            out["host"]["highlights"] = [
                h.get("title") or h.get("text") or str(h)
                for h in highlights if isinstance(h, dict)
            ]
        # About text (may appear here instead of on the User node)
        if not out["host"].get("about"):
            about = host_section.get("aboutHost") or host_section.get("about") or ""
            if about:
                out["host"]["about"] = _strip_html(about) if "<" in about else about

    # Co-hosts
    co_host_nodes = list(_walk(
        state,
        lambda d: d.get("__typename") in ("CoHost", "AdditionalHost")
        or (isinstance(d.get("coHosts"), list) and d["coHosts"])
    ))
    co_hosts = []
    for node in co_host_nodes:
        if isinstance(node.get("coHosts"), list):
            for ch in node["coHosts"]:
                co_hosts.append({
                    "name": ch.get("name") or ch.get("smartName"),
                    "role": ch.get("role") or "Co-host",
                    "profile_image_url": ch.get("pictureUrl"),
                })
        elif node.get("name") or node.get("smartName"):
            co_hosts.append({
                "name": node.get("name") or node.get("smartName"),
                "role": node.get("role") or "Co-host",
                "profile_image_url": node.get("pictureUrl"),
            })
    if co_hosts:
        out["host"]["co_hosts"] = co_hosts

    # Pricing
    price_node = first(
        _walk(state, lambda d: "structuredDisplayPrice" in d or ("price" in d and "amount" in (d.get("price") or {}))),
        None,
    )
    if price_node:
        sdp = price_node.get("structuredDisplayPrice") or {}
        primary = sdp.get("primaryLine") or {}
        amt = primary.get("price") or primary.get("discountedPrice")
        if amt:
            m = re.search(r"([\d,]+(?:\.\d+)?)", str(amt))
            if m:
                out["pricing"]["nightly_base"] = float(m.group(1).replace(",", ""))
        out["pricing"]["currency"] = sdp.get("currency") or _guess_currency(str(amt))

    # Reviews (summary only; full list extracted via modal scrape)
    #
    # Airbnb's schema drifts frequently. The count/rating live under several
    # different key names depending on the rollout; we try each in priority
    # order and record which one hit so future drift is easy to debug.
    #
    # Observed schemas (as of 2026-04):
    #   a) PdpReviewsSection style   → {overallCount: 24, overallRating: 4.83,
    #                                   seeAllReviewsButton: {title: "Show all 24 reviews"}}
    #   b) Sharing/metadata node     → {reviewCount: 24, starRating: 4.83}
    #   c) PdpOverviewV2ReviewData   → {reviewCount: "24", reviewCountText: "24 reviews",
    #                                   ratingText: "4.83"}
    #   d) Breakdown ratings node    → {visibleReviewCount: "24", guestSatisfactionOverall: 4.83,
    #                                   cleanlinessRating: …, accuracyRating: …, …}
    #   e) Legacy (pre-2025)         → {reviewsCount: 24, overallRating: 4.83,
    #                                   cleanlinessRating: …}
    def _to_int(v):
        if isinstance(v, (int, float)):
            return int(v)
        if isinstance(v, str):
            m = re.search(r"\d+", v)
            if m:
                try:
                    return int(m.group(0))
                except ValueError:
                    return None
        return None

    def _to_float(v):
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            m = re.search(r"\d+(?:\.\d+)?", v)
            if m:
                try:
                    return float(m.group(0))
                except ValueError:
                    return None
        return None

    review_count_candidates: list[tuple[int, str]] = []
    review_rating_candidates: list[tuple[float, str]] = []

    # (a) Rich review summary node — most authoritative: it's literally the
    # node that drives the "Show all N reviews" button the user sees.
    a_node = first(
        _walk(state, lambda d: "overallCount" in d and "overallRating" in d),
        None,
    )
    if a_node:
        c = _to_int(a_node.get("overallCount"))
        r = _to_float(a_node.get("overallRating"))
        if c is not None:
            review_count_candidates.append((c, "overallCount"))
        if r is not None:
            review_rating_candidates.append((r, "overallRating(a)"))
        # Cross-check against the button text — Airbnb sometimes de-syncs
        # the int field but the button label is always user-facing truth.
        btn = a_node.get("seeAllReviewsButton") or {}
        btn_label = btn.get("accessibilityLabel") or btn.get("title") or ""
        m = re.search(r"(\d[\d,]*)\s*review", btn_label, re.I)
        if m:
            try:
                review_count_candidates.append(
                    (int(m.group(1).replace(",", "")), "seeAllReviewsButton")
                )
            except ValueError:
                pass

    # (b) Sharing/metadata node — {reviewCount: int, starRating: float}
    b_node = first(
        _walk(state, lambda d: "reviewCount" in d and "starRating" in d),
        None,
    )
    if b_node:
        c = _to_int(b_node.get("reviewCount"))
        r = _to_float(b_node.get("starRating"))
        if c is not None:
            review_count_candidates.append((c, "reviewCount+starRating"))
        if r is not None:
            review_rating_candidates.append((r, "starRating"))

    # (c) PdpOverviewV2ReviewData — {reviewCount: "24", reviewCountText: "24 reviews"}
    c_node = first(
        _walk(state, lambda d: "reviewCountText" in d or d.get("__typename") == "PdpOverviewV2ReviewData"),
        None,
    )
    if c_node:
        c = _to_int(c_node.get("reviewCount")) or _to_int(c_node.get("reviewCountText"))
        r = _to_float(c_node.get("ratingText"))
        if c is not None:
            review_count_candidates.append((c, "PdpOverviewV2ReviewData"))
        if r is not None:
            review_rating_candidates.append((r, "ratingText"))

    # (d) Breakdown ratings node — {visibleReviewCount, guestSatisfactionOverall,
    # cleanlinessRating, …}. Also carries the category breakdown, which on the
    # modern schema is *separate* from the headline summary node.
    d_node = first(
        _walk(
            state,
            lambda d: (
                "cleanlinessRating" in d
                and ("guestSatisfactionOverall" in d or "visibleReviewCount" in d
                     or "overallRating" in d or "reviewsCount" in d)
            ),
        ),
        None,
    )
    if d_node:
        c = _to_int(d_node.get("visibleReviewCount")) or _to_int(d_node.get("reviewsCount"))
        r = _to_float(d_node.get("guestSatisfactionOverall")) or _to_float(d_node.get("overallRating"))
        if c is not None:
            review_count_candidates.append((c, "visibleReviewCount"))
        if r is not None:
            review_rating_candidates.append((r, "guestSatisfactionOverall"))
        breakdown = {}
        for k_src, k_dst in [
            ("cleanlinessRating", "cleanliness"),
            ("accuracyRating", "accuracy"),
            ("checkinRating", "checkin"),
            ("communicationRating", "communication"),
            ("locationRating", "location"),
            ("valueRating", "value"),
        ]:
            if d_node.get(k_src) is not None:
                breakdown[k_dst] = d_node[k_src]
        if breakdown:
            out["reviews"]["breakdown"] = breakdown

    # (e) Legacy path — pre-2025 key name
    e_node = first(
        _walk(state, lambda d: "reviewsCount" in d and "overallRating" in d),
        None,
    )
    if e_node:
        c = _to_int(e_node.get("reviewsCount"))
        r = _to_float(e_node.get("overallRating"))
        if c is not None:
            review_count_candidates.append((c, "reviewsCount(legacy)"))
        if r is not None:
            review_rating_candidates.append((r, "overallRating(legacy)"))
        if not out["reviews"].get("breakdown"):
            breakdown = {}
            for k_src, k_dst in [
                ("cleanlinessRating", "cleanliness"),
                ("accuracyRating", "accuracy"),
                ("checkinRating", "checkin"),
                ("communicationRating", "communication"),
                ("locationRating", "location"),
                ("valueRating", "value"),
            ]:
                if e_node.get(k_src) is not None:
                    breakdown[k_dst] = e_node[k_src]
            if breakdown:
                out["reviews"]["breakdown"] = breakdown

    # Pick the winning candidate. When multiple schemas agree, take the
    # majority value; if they disagree, prefer the richer PdpReviewsSection
    # (source "a") because that's the one wired to the user-visible button.
    if review_count_candidates:
        from collections import Counter
        values = [v for v, _ in review_count_candidates]
        counter = Counter(values)
        top_value, top_hits = counter.most_common(1)[0]
        if top_hits > 1:
            chosen_count = top_value
        else:
            priority = {"seeAllReviewsButton": 0, "overallCount": 1,
                        "reviewCount+starRating": 2, "PdpOverviewV2ReviewData": 3,
                        "visibleReviewCount": 4, "reviewsCount(legacy)": 5}
            chosen_count = sorted(
                review_count_candidates,
                key=lambda vs: priority.get(vs[1], 99),
            )[0][0]
        out["reviews"]["count"] = chosen_count
        out["reviews"]["_count_sources"] = [
            {"value": v, "source": s} for v, s in review_count_candidates
        ]
        print(
            f"INFO: Niobe review count = {chosen_count} "
            f"(candidates: {review_count_candidates})",
            file=sys.stderr,
        )

    if review_rating_candidates:
        # Average the candidates — they should all agree. If they don't,
        # log it so we can spot drift.
        uniq = sorted({round(r, 2) for r, _ in review_rating_candidates})
        if len(uniq) > 1:
            print(
                f"WARN: Niobe rating candidates disagree: "
                f"{review_rating_candidates}",
                file=sys.stderr,
            )
        out["reviews"]["average_rating"] = review_rating_candidates[0][0]

    # Reviews from Niobe state (primary source — doesn't require modal interaction)
    # Broad set of review type names to handle Airbnb schema changes
    REVIEW_TYPES = (
        "PdpReview", "Review", "MerlinReview", "PdpReviewV2",
        "StayReview", "ReviewV2", "GuestReview", "PdpReviewV3",
        "UserReview", "ListingReview", "BookingReview",
        "PdpReviewV4", "ReviewItem", "GuestReviewV2",
    )
    # All possible field names where Airbnb might store review text
    REVIEW_TEXT_KEYS = ("comments", "text", "reviewText", "comment",
                        "reviewContent", "commentBody", "publicReview",
                        "body", "value", "highlightedText")

    def _has_review_text(d: dict) -> str:
        """Return the review text from a dict if any review text key has content."""
        for k in REVIEW_TEXT_KEYS:
            v = d.get(k)
            if isinstance(v, str) and len(v) > 10:
                return v
        return ""

    niobe_reviews = list(_walk(
        state,
        lambda d: (
            d.get("__typename") in REVIEW_TYPES
            and _has_review_text(d)
        ),
    ))
    print(f"DEBUG: Niobe primary review search found {len(niobe_reviews)} reviews "
          f"(searched for __typename in {len(REVIEW_TYPES)} types)", file=sys.stderr)

    # Fallback 1: look for any dict with review text and reviewer info
    if not niobe_reviews:
        niobe_reviews = list(_walk(
            state,
            lambda d: (
                _has_review_text(d) != ""
                and len(_has_review_text(d)) > 20
                and (d.get("reviewerName") or d.get("reviewer") or d.get("authorName")
                     or d.get("reviewee") or d.get("author"))
                and not d.get("__typename", "").endswith("Section")
            ),
        ))
        print(f"DEBUG: Niobe fallback 1 (reviewer+text) found {len(niobe_reviews)} reviews", file=sys.stderr)

    # Fallback 2: look for review data inside section containers
    if not niobe_reviews:
        review_sections = list(_walk(
            state,
            lambda d: (
                (d.get("sectionId") or "").upper().startswith("REVIEW")
                or (d.get("sectionId") or "").upper().startswith("GUEST_REVIEW")
                or d.get("__typename") in ("PdpReviewsSection", "ReviewsSection",
                                            "GuestReviewsSection", "PdpReviewsSectionV2",
                                            "PdpReviewsSectionV3", "StayReviewsSection")
            ),
        ))
        print(f"DEBUG: Found {len(review_sections)} review section containers", file=sys.stderr)
        for rsect in review_sections:
            # Log section keys so we can debug
            print(f"DEBUG: Review section keys: {list(rsect.keys())[:25]}", file=sys.stderr)
            # Try extracting from known array keys
            for key in ("reviews", "reviewItems", "items", "data", "reviewData",
                        "reviewCards", "section", "sectionData", "content"):
                items = rsect.get(key)
                if isinstance(items, list):
                    for item in items:
                        if isinstance(item, dict) and _has_review_text(item):
                            niobe_reviews.append(item)
                elif isinstance(items, dict):
                    # sectionData might be a dict containing reviews
                    for sub_key in ("reviews", "reviewItems", "items"):
                        sub_items = items.get(sub_key)
                        if isinstance(sub_items, list):
                            for item in sub_items:
                                if isinstance(item, dict) and _has_review_text(item):
                                    niobe_reviews.append(item)
            # Also walk within the section for nested reviews
            if not niobe_reviews:
                nested = list(_walk(
                    rsect,
                    lambda d: (
                        _has_review_text(d) != ""
                        and len(_has_review_text(d)) > 15
                        and d is not rsect
                    ),
                ))
                niobe_reviews.extend(nested)
        print(f"DEBUG: Niobe fallback 2 (section walk) found {len(niobe_reviews)} reviews", file=sys.stderr)

    # Fallback 3: broadest possible — any dict with substantial review-like text
    if not niobe_reviews:
        niobe_reviews = list(_walk(
            state,
            lambda d: (
                _has_review_text(d) != ""
                and len(_has_review_text(d)) > 30
                and not d.get("__typename", "").endswith("Section")
                and not d.get("__typename", "").endswith("Controller")
                and not d.get("__typename", "").endswith("Metadata")
                # Exclude description-like nodes
                and "description" not in (d.get("__typename") or "").lower()
            ),
        ))
        print(f"DEBUG: Niobe fallback 3 (broadest) found {len(niobe_reviews)} text nodes", file=sys.stderr)

    # Fallback 4: dump all __typename values that contain "review" for diagnosis
    if not niobe_reviews:
        review_typenames = set()
        for node in _walk(state, lambda d: "review" in (d.get("__typename") or "").lower()):
            review_typenames.add(node.get("__typename"))
        if review_typenames:
            print(f"DEBUG: Found these review-related __typename values: {review_typenames}", file=sys.stderr)
            # Try to extract from these types regardless of text key
            for tname in review_typenames:
                typed = list(_walk(state, lambda d: d.get("__typename") == tname))
                for t in typed:
                    if len(str(t)) > 50:  # has some content
                        print(f"DEBUG: {tname} node keys: {list(t.keys())[:20]}", file=sys.stderr)
                        # Try all possible text fields
                        for k, v in t.items():
                            if isinstance(v, str) and len(v) > 15 and k not in ("__typename", "id", "sectionId"):
                                print(f"DEBUG: Potential review text in {tname}.{k}: {v[:100]}", file=sys.stderr)
                                niobe_reviews.append(t)
                                break

    if niobe_reviews:
        niobe_extracted = []
        seen_texts = set()
        for rv in niobe_reviews:
            reviewer_raw = rv.get("reviewer") or rv.get("author")
            reviewer_name = (
                rv.get("reviewerName")
                or rv.get("authorName")
                or rv.get("reviewerFirstName")
                or (reviewer_raw.get("firstName", "") if isinstance(reviewer_raw, dict)
                    else reviewer_raw.get("smartName", "") if isinstance(reviewer_raw, dict)
                    else str(reviewer_raw or ""))
            )
            text = _has_review_text(rv)
            if not text or text[:60] in seen_texts:
                continue
            seen_texts.add(text[:60])
            niobe_extracted.append({
                "reviewer": reviewer_name,
                "date": rv.get("localizedDate") or rv.get("createdAt") or rv.get("date") or rv.get("reviewDate") or "",
                "text": text,
                "rating": rv.get("rating"),
                "language": rv.get("language"),
            })
        out["reviews"]["niobe_reviews"] = niobe_extracted
        print(f"INFO: Extracted {len(niobe_extracted)} reviews from Niobe state", file=sys.stderr)

    # Badges (Superhost, Guest Favourite, percentile)
    badges = set()
    for node in _walk(state, lambda d: isinstance(d.get("badge"), str)):
        badges.add(node["badge"])
    for node in _walk(state, lambda d: d.get("__typename") == "MerchandisingPill" and d.get("title")):
        badges.add(node["title"])
    if out["host"].get("superhost"):
        badges.add("Superhost")
    out["reviews"]["badges"] = sorted(badges)

    # Policies
    rules = first(_walk(state, lambda d: d.get("__typename") == "HouseRulesSection"), None)
    if rules:
        texts = []
        for sect in rules.get("houseRulesSections", []) or []:
            for item in sect.get("items", []) or []:
                if item.get("title"):
                    texts.append(item["title"])
        out["policies"]["house_rules"] = "\n".join(texts) if texts else None

    cancel = first(
        _walk(state, lambda d: "cancellationPolicyLabel" in d or d.get("__typename") == "PoliciesSection"),
        None,
    )
    if cancel:
        out["policies"]["cancellation"] = (
            cancel.get("cancellationPolicyLabel")
            or _strip_html(cancel.get("cancellationPolicyForDisplay", "") or "")
            or None
        )

    # Location — extract neighbourhood, city, coordinates, and transit info
    loc = first(
        _walk(state, lambda d: "locationTitle" in d or d.get("__typename") == "LocationSection"),
        None,
    )
    if loc:
        out["location"]["neighbourhood"] = loc.get("locationTitle") or loc.get("cityName")
        if loc.get("lat") and loc.get("lng"):
            out["location"]["lat"] = loc["lat"]
            out["location"]["lng"] = loc["lng"]
        # Location description (transit, nearby places)
        if loc.get("locationDescription"):
            out["location"]["description"] = _strip_html(loc["locationDescription"]) if "<" in loc["locationDescription"] else loc["locationDescription"]
        # Nearby transit/highlights
        nearby = loc.get("nearbyPublicTransit") or loc.get("seeAllGettingAroundItems") or []
        if nearby:
            out["location"]["transit"] = [
                {"name": n.get("title") or n.get("text", ""), "distance": n.get("subtitle") or n.get("distance", "")}
                for n in nearby if isinstance(n, dict)
            ]

    # Also look for coordinates elsewhere in state (common in map nodes)
    if "lat" not in out["location"]:
        geo_node = first(
            _walk(state, lambda d: isinstance(d.get("lat"), (int, float)) and isinstance(d.get("lng"), (int, float))),
            None,
        )
        if geo_node:
            out["location"]["lat"] = geo_node["lat"]
            out["location"]["lng"] = geo_node["lng"]

    return out


def _strip_html(s: str) -> str:
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</p>", "\n\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def _guess_currency(s: str) -> Optional[str]:
    for sign, code in (("£", "GBP"), ("$", "USD"), ("€", "EUR"),
                        ("A$", "AUD"), ("C$", "CAD")):
        if sign in s:
            return code
    return None


def extract_reviews_from_modal(page) -> list[dict]:
    """Parse every review card currently rendered in the reviews modal."""
    raw = page.evaluate(
        """
        () => {
          const cards = Array.from(
            document.querySelectorAll("div[role='dialog'] div[data-review-id], "
              + "div[role='dialog'] div[data-testid='pdp-review-card']")
          );
          return cards.map(c => {
            const reviewer = (c.querySelector("h2, h3, [data-testid='review-user-name']") || {}).textContent || '';
            const date = (c.querySelector("time, [data-testid='review-date'], li[data-testid='review-date']") || {}).textContent || '';
            // Date sometimes lives in the element immediately after the reviewer name.
            const text = (c.querySelector("span[dir='ltr'], div[dir='ltr'], [data-testid='review-text']") || {}).textContent || '';
            const ratingEl = c.querySelector("[aria-label*='Rating'], [aria-label*='stars']");
            const label = ratingEl ? (ratingEl.getAttribute('aria-label') || '') : '';
            const m = label.match(/([0-9](?:\\.[0-9])?)/);
            return {
              reviewer: reviewer.trim(),
              date: date.trim(),
              text: text.trim(),
              rating: m ? parseFloat(m[1]) : null,
            };
          }).filter(r => r.text);
        }
        """
    )
    # De-dup on (reviewer, date, first 80 chars of text).
    seen = set()
    out = []
    for r in raw or []:
        key = (r.get("reviewer"), r.get("date"), (r.get("text") or "")[:80])
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


# ---------------------------------------------------------------------------
# DOM fallbacks — used whenever the Niobe GraphQL walk misses fields.
# ---------------------------------------------------------------------------

def _dom_fallbacks(page, data: dict) -> None:
    """Fill in critical gaps (title, hero image, host name, description, price)
    from the rendered DOM. Only writes when the current value is falsy, so a
    successful Niobe walk is never overridden.
    """
    # Title — Airbnb page title format: "<Title> - <Type> for Rent in <Place> - Airbnb"
    if not data["content"].get("title") or not data["property"].get("name"):
        raw_title = ""
        try:
            raw_title = page.title() or ""
        except Exception:
            pass
        # Prefer an <h1> inside the listing section; fall back to page title.
        h1 = ""
        try:
            h1 = page.evaluate(
                "() => { const el = document.querySelector(\"h1, [data-section-id='TITLE_DEFAULT'] h1\"); return el ? (el.textContent || '').trim() : ''; }"
            ) or ""
        except Exception:
            pass
        best = h1.strip() or raw_title.split(" - ")[0].strip()
        if best:
            data["content"].setdefault("title", best)
            data["property"].setdefault("name", best)

    # Description fallback — try clicking "Read more" first, then extract from
    # the rendered description section, then fall back to meta tag.
    if not data["content"].get("description"):
        # Click "Read more" / "Show more" to expand the description
        for sel in [
            "[data-section-id='DESCRIPTION_DEFAULT'] button",
            "button:has-text('Read more')",
            "button:has-text('Show more')",
        ]:
            if _safe_click(page, sel, timeout_ms=1500):
                page.wait_for_timeout(500)
                break
        try:
            desc_text = page.evaluate(
                """() => {
                    // Try the description section
                    const section = document.querySelector("[data-section-id='DESCRIPTION_DEFAULT']")
                        || document.querySelector("[data-section-id='DESCRIPTION']");
                    if (section) {
                        // Get all text-bearing elements, deduplicate by checking
                        // that children don't repeat parent text
                        const spans = Array.from(section.querySelectorAll("span, p"))
                            .filter(el => {
                                const t = (el.textContent || '').trim();
                                return t.length > 15
                                    && !t.match(/^(Read more|Show more|About this|The space|Guest access)/i)
                                    && el.children.length === 0;  // leaf nodes only
                            });
                        if (spans.length) return spans.map(el => el.textContent.trim()).join('\\n\\n');
                        // Fallback: get the whole section text minus buttons
                        const clone = section.cloneNode(true);
                        clone.querySelectorAll('button, a').forEach(el => el.remove());
                        const text = (clone.textContent || '').trim();
                        if (text.length > 30) return text;
                    }
                    return '';
                }"""
            ) or ""
            if desc_text:
                data["content"]["description"] = desc_text.strip()
        except Exception:
            pass
        # Final fallback: meta tag
        if not data["content"].get("description"):
            try:
                meta = page.evaluate(
                    "() => { const m = document.querySelector(\"meta[name='description']\"); return m ? (m.getAttribute('content') || '') : ''; }"
                ) or ""
                if meta:
                    data["content"]["description"] = meta.strip()
            except Exception:
                pass

    # Hero image — og:image is a reliable fallback on Airbnb.
    if not data["images"].get("hero_image_url"):
        try:
            og = page.evaluate(
                "() => { const m = document.querySelector(\"meta[property='og:image']\"); return m ? (m.getAttribute('content') || '') : ''; }"
            ) or ""
            if og:
                data["images"]["hero_image_url"] = og.strip()
        except Exception:
            pass

    # Host name — the "Hosted by X" section is visible on every PDP.
    if not data["host"].get("name"):
        try:
            host_name = page.evaluate(
                """
                () => {
                  const re = /Hosted by\\s+([^\\n]+)/i;
                  const texts = Array.from(document.querySelectorAll("h2, div, span"))
                    .map(el => (el.textContent || '').trim())
                    .filter(t => re.test(t));
                  if (!texts.length) return '';
                  const m = texts[0].match(re);
                  return m ? m[1].trim().replace(/[\\s·•].*$/, '') : '';
                }
                """
            ) or ""
            if host_name:
                data["host"]["name"] = host_name.strip()
        except Exception:
            pass

    # Price — search the visible body for a currency+number near "night".
    if not data["pricing"].get("nightly_base"):
        try:
            price = page.evaluate(
                """
                () => {
                  const body = (document.body.innerText || '');
                  const m = body.match(/([£$€])\\s?(\\d{1,4}(?:[.,]\\d{2})?)\\s*(?:\\/|per)?\\s*night/i);
                  return m ? { currency: m[1], amount: m[2] } : null;
                }
                """
            )
            if price:
                cur_map = {"£": "GBP", "$": "USD", "€": "EUR"}
                data["pricing"]["currency"] = cur_map.get(price.get("currency"), price.get("currency"))
                try:
                    data["pricing"]["nightly_base"] = float(str(price.get("amount", "0")).replace(",", "."))
                except Exception:
                    data["pricing"]["nightly_base"] = price.get("amount")
        except Exception:
            pass

    # Review count + rating — last-resort DOM fallback when the Niobe walk
    # missed (e.g. after a schema rename). We read the headline number from
    # the user-visible "Show all N reviews" button, the reviews h2 ("4.83 · 24
    # reviews"), or the aria-label ("Rated 4.83 out of 5 stars from 24 reviews").
    # NEVER infer the count from len(extracted_reviews) — that's what produced
    # the old "2 reviews" regression when the modal/inline scrape got stuck on
    # two DOM fragments.
    if not data["reviews"].get("count") or not data["reviews"].get("average_rating"):
        try:
            dom_rev = page.evaluate(
                r"""() => {
                    const result = { count: null, rating: null, source: null };
                    const texts = new Set();

                    // Collect candidate text sources in priority order
                    const sources = [];
                    document.querySelectorAll('[aria-label*="review" i]').forEach(el => {
                        const a = el.getAttribute('aria-label');
                        if (a) sources.push({ text: a, source: 'aria-label' });
                    });
                    document.querySelectorAll('h1, h2, h3').forEach(el => {
                        const t = (el.textContent || '').trim();
                        if (/review/i.test(t)) sources.push({ text: t, source: 'heading' });
                    });
                    // Anchor/button text like "Show all 24 reviews"
                    document.querySelectorAll('a, button').forEach(el => {
                        const t = (el.textContent || '').trim();
                        if (/show all .*review/i.test(t)) sources.push({ text: t, source: 'show-all' });
                    });

                    // Extract the first "N review(s)" integer we find
                    for (const s of sources) {
                        const m = s.text.match(/(\d[\d,]*)\s*review/i);
                        if (m) {
                            const n = parseInt(m[1].replace(/,/g, ''), 10);
                            if (!isNaN(n) && n > 0) {
                                result.count = n;
                                result.source = s.source;
                                break;
                            }
                        }
                    }

                    // Extract rating — look for "X.XX out of 5" first, then
                    // "X.XX · N reviews" patterns.
                    for (const s of sources) {
                        let m = s.text.match(/(\d(?:\.\d{1,2})?)\s*out of\s*5/i);
                        if (!m) m = s.text.match(/(\d\.\d{1,2})\s*[·•]\s*\d+\s*review/i);
                        if (m) {
                            const r = parseFloat(m[1]);
                            if (!isNaN(r) && r > 0 && r <= 5) {
                                result.rating = r;
                                break;
                            }
                        }
                    }
                    return result;
                }"""
            ) or {}
            if dom_rev.get("count") and not data["reviews"].get("count"):
                data["reviews"]["count"] = dom_rev["count"]
                print(
                    f"INFO: DOM fallback set reviews.count = {dom_rev['count']} "
                    f"(source: {dom_rev.get('source')})",
                    file=sys.stderr,
                )
            if dom_rev.get("rating") and not data["reviews"].get("average_rating"):
                data["reviews"]["average_rating"] = dom_rev["rating"]
                print(
                    f"INFO: DOM fallback set reviews.average_rating = {dom_rev['rating']}",
                    file=sys.stderr,
                )
        except Exception as _e:
            print(f"WARN: DOM review-count fallback failed: {_e}", file=sys.stderr)

    # Property type — extract from the breadcrumb or page title
    if not data["property"].get("property_type"):
        try:
            ptype = page.evaluate(
                """() => {
                    // Try page title pattern: "... - Apartment for rent ..."
                    const title = document.title || '';
                    const m = title.match(/\\b(apartment|flat|house|villa|condo|cottage|loft|penthouse|studio|cabin|bungalow|townhouse|chalet|barn|houseboat|treehouse|tent|yurt|farm stay|castle|mansion)\\b/i);
                    if (m) return m[1];
                    // Try breadcrumb or subtitle
                    const sub = document.querySelector('[data-section-id="TITLE_DEFAULT"] h2, [data-section-id="TITLE_DEFAULT"] span');
                    if (sub) {
                        const t = sub.textContent || '';
                        const m2 = t.match(/\\b(apartment|flat|house|villa|condo|cottage|loft|penthouse|studio|cabin|bungalow|townhouse|chalet)\\b/i);
                        if (m2) return m2[1];
                    }
                    return '';
                }"""
            ) or ""
            if ptype:
                data["property"]["property_type"] = ptype.strip().title()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Cloudinary
# ---------------------------------------------------------------------------

def upload_to_cloudinary(image_url: str, public_id: str) -> Optional[str]:
    """Upload a remote image to Cloudinary /lucas folder. Returns secure_url or None."""
    if not image_url:
        return None
    try:
        import cloudinary
        import cloudinary.uploader
    except ImportError:
        print("WARN: cloudinary package not installed; skipping upload", file=sys.stderr)
        return None

    cloud = os.environ.get("CLOUDINARY_CLOUD_NAME", "dptcyvz30")
    key = os.environ.get("CLOUDINARY_API_KEY")
    secret = os.environ.get("CLOUDINARY_API_SECRET")
    folder = os.environ.get("CLOUDINARY_FOLDER", "lucas")

    if not (key and secret):
        print("WARN: Cloudinary credentials missing; skipping upload", file=sys.stderr)
        return None

    cloudinary.config(cloud_name=cloud, api_key=key, api_secret=secret, secure=True)
    try:
        resp = cloudinary.uploader.upload(
            image_url,
            folder=folder,
            public_id=public_id,
            overwrite=True,
            resource_type="image",
        )
        return resp.get("secure_url")
    except Exception as e:
        print(f"WARN: Cloudinary upload failed for {public_id}: {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def scrape(url: str, headless: bool = True, timeout_ms: int = 30000) -> dict:
    from playwright.sync_api import sync_playwright

    canonical_url, listing_id = normalise_url(url)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
            ],
        )
        ctx = browser.new_context(
            locale="en-GB",
            timezone_id="Europe/London",
            viewport={"width": 1440, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = ctx.new_page()
        page.set_default_timeout(timeout_ms)

        page.goto(canonical_url, wait_until="domcontentloaded")
        # Networkidle is flaky on Airbnb; wait for key sections instead.
        try:
            page.wait_for_selector("h1, [data-section-id='TITLE_DEFAULT']", timeout=timeout_ms)
        except Exception:
            pass
        dismiss_modals(page)
        page.wait_for_timeout(1500)

        # Primary data source: deferred-state JSON.
        niobe = extract_niobe_state(page)
        data = extract_from_niobe(niobe) if niobe else {
            "property": {}, "host": {}, "content": {}, "amenities": [],
            "pricing": {}, "reviews": {}, "policies": {}, "location": {},
            "images": {},
        }

        # Diagnostic: log what was found/missed from Niobe for debugging
        _niobe_rev_count = len(data["reviews"].get("niobe_reviews") or [])
        _found = {k: bool(v) if not isinstance(v, int) else v for k, v in {
            "title": data["content"].get("title"),
            "description": data["content"].get("description"),
            "host_name": data["host"].get("name"),
            "reviews_count": data["reviews"].get("count"),
            "niobe_reviews": _niobe_rev_count,
            "amenities": len(data["amenities"]),
            "pricing": data["pricing"].get("nightly_base"),
            "hero_image": data["images"].get("hero_image_url"),
        }.items()}
        print(f"INFO: Niobe extraction results: {_found}", file=sys.stderr)
        if data["reviews"].get("count") and _niobe_rev_count == 0:
            print(f"WARN: Listing reports {data['reviews']['count']} reviews but Niobe extracted 0 — will try modal/DOM fallbacks", file=sys.stderr)

        # DOM fallbacks — the GraphQL state shape drifts; these keep the PDF
        # usable even when the Niobe walk misses fields. Only fills gaps.
        try:
            _dom_fallbacks(page, data)
        except Exception as _e:
            print(f"WARN: DOM fallback failed: {_e}", file=sys.stderr)

        # Ensure full amenities list even when JSON source misses some.
        if not data["amenities"]:
            expand_amenities(page)
            data["amenities"] = page.evaluate(
                """() => Array.from(
                     document.querySelectorAll("div[role='dialog'] div[id^='amenity-row-']")
                   ).map(n => (n.textContent || '').trim()).filter(Boolean)"""
            ) or []
            _safe_click(page, "div[role='dialog'] button[aria-label='Close']")

        # Reviews — try multiple approaches to capture all reviews.
        all_reviews: list[dict] = []

        # Attempt 1: Try clicking review-related buttons/links to open the modal
        # For listings with few reviews, the button text varies
        review_modal_opened = False
        for sel in [
            "button:has-text('Show all ')",
            "a:has-text('Show all reviews')",
            "button[data-testid='pdp-show-all-reviews-button']",
            "a:has-text(' review')",  # matches "2 reviews", "1 review", etc.
            "button:has-text(' review')",
            "[data-section-id='REVIEWS_DEFAULT'] button",
            "[data-section-id='REVIEWS_DEFAULT'] a",
            "[role='region'] a:has-text('review')",
            "[role='region'] button:has-text('review')",
        ]:
            if _safe_click(page, sel, timeout_ms=2000):
                try:
                    page.locator("div[role='dialog']").first.wait_for(
                        state="visible", timeout=4000
                    )
                    review_modal_opened = True
                    break
                except Exception:
                    continue

        # Platform-reported total — drives reconciliation. If Niobe didn't
        # surface a count, we fall back to whatever extraction returns.
        platform_review_count = data["reviews"].get("count")

        if review_modal_opened:
            scroll_reviews_modal(page, expected_count=platform_review_count)
            all_reviews = extract_reviews_from_modal(page)
            print(
                f"INFO: Modal extraction (Attempt 1) found {len(all_reviews)} reviews "
                f"(platform reports {platform_review_count})",
                file=sys.stderr,
            )

            # Reconciliation: if we got significantly fewer than the platform
            # claims, re-scroll harder. This rescues the common case where the
            # virtualised list briefly stalls between batches.
            if (
                platform_review_count
                and len(all_reviews) < max(6, int(platform_review_count * 0.8))
            ):
                print(
                    f"WARN: Modal extraction got {len(all_reviews)}/{platform_review_count} — "
                    "running second scroll pass with extra patience",
                    file=sys.stderr,
                )
                scroll_reviews_modal(
                    page,
                    max_rounds=300,
                    stagnant_limit=12,
                    settle_ms=1500,
                    expected_count=platform_review_count,
                )
                retry_reviews = extract_reviews_from_modal(page)
                if len(retry_reviews) > len(all_reviews):
                    print(
                        f"INFO: Reconciliation pass improved extraction "
                        f"{len(all_reviews)} → {len(retry_reviews)}",
                        file=sys.stderr,
                    )
                    all_reviews = retry_reviews
            _safe_click(page, "div[role='dialog'] button[aria-label='Close']")

        # Attempt 2: Extract reviews displayed inline on the page (no modal)
        if not all_reviews:
            inline_reviews = page.evaluate(
                """() => {
                    // Look for review section using multiple strategies
                    // Strategy A: data-section-id attributes (older Airbnb layouts)
                    let section = document.querySelector("[data-section-id='REVIEWS_DEFAULT']")
                        || document.querySelector("[data-section-id='GUEST_REVIEWS']")
                        || document.querySelector("[data-section-id='REVIEWS']");

                    // Strategy B: region element with review-related heading (current Airbnb layout)
                    if (!section) {
                        const regions = document.querySelectorAll('[role="region"], region, section');
                        for (const r of regions) {
                            const heading = r.querySelector('h2, h3, [role="heading"]');
                            if (heading && /\\d+\\s*review/i.test(heading.textContent || '')) {
                                section = r;
                                break;
                            }
                        }
                    }

                    // Strategy C: aria-label with "review" on any container
                    if (!section) {
                        section = document.querySelector('[aria-label*="review" i]')
                            || document.querySelector('[aria-label*="Review" i]');
                    }

                    // Strategy D: heading containing "review" and walk up to its section
                    if (!section) {
                        const headings = document.querySelectorAll('h2, h3');
                        for (const h of headings) {
                            if (/\\d+\\s*review/i.test(h.textContent || '')) {
                                // Walk up to find the containing section
                                let parent = h.parentElement;
                                for (let i = 0; i < 5 && parent; i++) {
                                    if (parent.children.length > 1) {
                                        section = parent;
                                        break;
                                    }
                                    parent = parent.parentElement;
                                }
                                break;
                            }
                        }
                    }

                    // Strategy E: id containing 'review'
                    if (!section) {
                        section = document.querySelector("[id*='review']");
                    }

                    if (!section) return [];

                    // Find all review text blocks within the section
                    const cards = section.querySelectorAll('[data-review-id], [role="listitem"], [data-testid="pdp-review-card"]');
                    if (!cards.length) {
                        // Fallback: look for spans/divs with substantial text within the reviews section
                        const textEls = Array.from(section.querySelectorAll('span, div'))
                            .filter(el => {
                                const t = (el.textContent || '').trim();
                                // Must be substantial text, not a heading or date
                                return t.length > 30 && t.length < 3000
                                    && !(/^\\d+\\s*review/i.test(t))  // skip heading
                                    && el.children.length < 5  // prefer leaf-ish nodes
                                    && !el.querySelector('h2, h3');  // skip container nodes
                            });
                        // Deduplicate — child text is repeated in parent
                        const seen = new Set();
                        const unique = [];
                        for (const el of textEls) {
                            const t = (el.textContent || '').trim();
                            const key = t.substring(0, 80);
                            if (!seen.has(key)) {
                                seen.add(key);
                                unique.push(el);
                            }
                        }
                        return unique.map(el => ({
                            reviewer: '',
                            date: '',
                            text: (el.textContent || '').trim(),
                            rating: null,
                        }));
                    }
                    return Array.from(cards).map(c => {
                        const reviewer = (c.querySelector('h2, h3, [data-testid="review-user-name"]') || {}).textContent || '';
                        const date = (c.querySelector('time, [data-testid="review-date"]') || {}).textContent || '';
                        // Try dir="ltr" first, then fall back to finding the longest leaf text
                        let textEl = c.querySelector('span[dir="ltr"], div[dir="ltr"], [data-testid="review-text"]');
                        let text = textEl ? (textEl.textContent || '').trim() : '';
                        if (!text) {
                            // Fallback: find the longest leaf-ish text that isn't the reviewer name
                            const candidates = Array.from(c.querySelectorAll('span, div'))
                                .filter(el => {
                                    const t = (el.textContent || '').trim();
                                    return t.length > 30 && el.children.length <= 1
                                        && !el.querySelector('h2,h3,img,a');
                                })
                                .sort((a, b) => b.textContent.length - a.textContent.length);
                            for (const el of candidates) {
                                const t = (el.textContent || '').trim();
                                if (!t.startsWith(reviewer) || t.length > reviewer.length + 50) {
                                    text = t;
                                    break;
                                }
                            }
                        }
                        return { reviewer: reviewer.trim(), date: date.trim(), text: text.trim(), rating: null };
                    }).filter(r => r.text.length > 10);
                }"""
            ) or []
            print(f"DEBUG: Inline review extraction (Attempt 2) found {len(inline_reviews)} reviews", file=sys.stderr)
            if inline_reviews:
                for i, ir in enumerate(inline_reviews):
                    print(f"DEBUG: Inline review {i+1}: {(ir.get('text') or '')[:100]}", file=sys.stderr)
                all_reviews = inline_reviews

        # Attempt 3: Broadest DOM search — find any substantial review-like text on the page
        if not all_reviews:
            broad_reviews = page.evaluate(
                """() => {
                    const results = [];
                    const seen = new Set();

                    function addReview(text, reviewer) {
                        text = (text || '').trim();
                        const key = text.substring(0, 80);
                        if (text.length > 30 && text.length < 5000 && !seen.has(key)) {
                            seen.add(key);
                            results.push({ reviewer: (reviewer || '').trim(), date: '', text: text, rating: null });
                        }
                    }

                    // Try data-review-id and test-id selectors
                    for (const el of document.querySelectorAll('[data-review-id], [data-testid*="review"]')) {
                        addReview(el.textContent);
                    }

                    // Try aria-label patterns
                    if (!results.length) {
                        for (const el of document.querySelectorAll('[aria-label*="Rating"], [aria-label*="rating"]')) {
                            const parent = el.closest('[role="listitem"], div');
                            if (parent) addReview(parent.textContent);
                        }
                    }

                    // Try finding review containers near "review" headings
                    if (!results.length) {
                        const headings = document.querySelectorAll('h2, h3');
                        for (const h of headings) {
                            if (/\\d+\\s*review/i.test(h.textContent || '')) {
                                // Found the reviews heading — look at sibling elements
                                let container = h.parentElement;
                                for (let i = 0; i < 3 && container; i++) {
                                    container = container.parentElement;
                                }
                                if (container) {
                                    // Find substantial text blocks that are likely reviews
                                    const blocks = container.querySelectorAll('span, div, p');
                                    for (const b of blocks) {
                                        const t = (b.textContent || '').trim();
                                        if (t.length > 40 && t.length < 2000
                                            && b.children.length < 3
                                            && !(/^\\d+\\s*review/i.test(t))) {
                                            addReview(t);
                                        }
                                    }
                                }
                                break;
                            }
                        }
                    }

                    return results;
                }"""
            ) or []
            if broad_reviews:
                print(f"INFO: Found {len(broad_reviews)} reviews via broad DOM search", file=sys.stderr)
                all_reviews = broad_reviews

        # If modal scrape got nothing but we have Niobe reviews, use those
        niobe_revs = data["reviews"].get("niobe_reviews") or []
        if not all_reviews and niobe_revs:
            print(f"INFO: Modal scrape returned 0 reviews, using {len(niobe_revs)} from Niobe state", file=sys.stderr)
            all_reviews = niobe_revs
        elif all_reviews and niobe_revs and len(niobe_revs) > len(all_reviews):
            # Niobe had more reviews than the modal — merge them
            print(f"INFO: Merging {len(niobe_revs)} Niobe reviews with {len(all_reviews)} modal reviews", file=sys.stderr)
            existing_texts = {(r.get("text") or "")[:80] for r in all_reviews}
            for nr in niobe_revs:
                if (nr.get("text") or "")[:80] not in existing_texts:
                    all_reviews.append(nr)

        data["reviews"]["all_reviews"] = all_reviews
        # Clean up the intermediate niobe_reviews key
        data["reviews"].pop("niobe_reviews", None)
        # DO NOT silently set count = len(all_reviews) here. That was the
        # 2026-04-19 regression: when Niobe missed (schema rename) and the
        # inline DOM scrape grabbed only two review-ish fragments, the
        # headline number reported to the host was "2" instead of the real
        # 24. The DOM fallback above already populates count from the
        # user-visible "Show all N reviews" label. If it's still missing
        # here it means the page genuinely had no such label and we should
        # leave count unset rather than manufacture a wrong one.
        if not data["reviews"].get("count") and all_reviews:
            print(
                f"WARN: No platform count found but extracted {len(all_reviews)} "
                "reviews — leaving reviews.count unset rather than inferring a "
                "wrong total. If you see this, inspect the DOM fallback logs.",
                file=sys.stderr,
            )

        # Explicit flag and diagnostic logging for reviews
        review_count = data["reviews"].get("count") or 0
        extracted_count = len(all_reviews)
        data["reviews"]["has_reviews"] = review_count > 0 or extracted_count > 0
        data["reviews"]["extracted_count"] = extracted_count
        # Gap flag — true when the platform count disagrees meaningfully with
        # what we actually extracted. Downstream (analysis + PDF) uses this
        # to trust the platform headline number and note the shortfall instead
        # of pretending we only had 6 reviews.
        data["reviews"]["extraction_gap"] = bool(
            review_count and extracted_count < max(6, int(review_count * 0.8))
        )
        print(f"INFO: Reviews summary — platform count={review_count}, extracted={extracted_count}, "
              f"gap={data['reviews']['extraction_gap']}, "
              f"average_rating={data['reviews'].get('average_rating')}, "
              f"breakdown keys={list((data['reviews'].get('breakdown') or {}).keys())}", file=sys.stderr)
        if extracted_count == 0 and review_count > 0:
            print(f"WARN: Platform reports {review_count} reviews but extraction got 0. "
                  f"Review data may be missing from the analysis.", file=sys.stderr)
        elif data["reviews"]["extraction_gap"]:
            print(
                f"WARN: Platform reports {review_count} reviews but we extracted only "
                f"{extracted_count}. Headline count will still show the platform value; "
                f"sentiment analysis will caveat the gap.",
                file=sys.stderr,
            )
        elif extracted_count == 0:
            print(f"INFO: Listing has no reviews (new or unreviewed listing).", file=sys.stderr)

        browser.close()

    # Cloudinary uploads
    hero = data["images"].get("hero_image_url")
    profile = data["host"].get("profile_image_url")
    data["images"]["hero_cloudinary_url"] = upload_to_cloudinary(
        hero, public_id=f"{listing_id}_hero"
    ) if hero else None
    data["images"]["profile_cloudinary_url"] = upload_to_cloudinary(
        profile, public_id=f"{listing_id}_host"
    ) if profile else None

    return {
        "status": "success",
        "platform": "airbnb",
        "url": canonical_url,
        "listing_id": listing_id,
        "scraped_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        **data,
    }


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Scrape an Airbnb listing for Lucas.")
    parser.add_argument("url", help="Full Airbnb listing URL")
    parser.add_argument(
        "--no-headless", dest="headless", action="store_false",
        help="Run Chromium headed (for debugging)",
    )
    parser.add_argument(
        "--timeout", type=int, default=int(os.environ.get("LUCAS_TIMEOUT_MS", "30000")),
        help="Per-action timeout in milliseconds (default 30000)",
    )
    parser.add_argument(
        "--pretty", action="store_true", help="Pretty-print JSON (default compact)",
    )
    args = parser.parse_args(argv)

    headless_env = os.environ.get("LUCAS_HEADLESS", "1") != "0"
    headless = args.headless and headless_env

    try:
        result = scrape(args.url, headless=headless, timeout_ms=args.timeout)
        print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))
        return 0
    except Exception as e:
        err = {
            "status": "error",
            "platform": "airbnb",
            "url": args.url,
            "scraped_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "message": str(e),
            "trace": traceback.format_exc(),
        }
        print(json.dumps(err, ensure_ascii=False, indent=2 if args.pretty else None))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
