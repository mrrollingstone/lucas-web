"""
Lucas — Phase 3: PDF report generator
======================================

Takes a Phase 2 analysis JSON (and the Phase 1 scraped JSON for imagery/host
details) and renders a branded A4 PDF report signed by Lucas, HelloHosty's
AI Listing Optimisation Assistant.

Layout (target ~12 pages):
  1.  Cover
  2.  Dashboard / Cockpit
  3-4 Quick wins
  5-7 Listing content review
  8-9 Amenities review
  10. Pricing analysis
  11. Platform cross-reference (skipped when single-platform)
  12. Next steps + upsell

Usage
-----
    python listing_review_pdf.py \\
        --scraped fixtures/sample_airbnb_listing.json \\
        --analysis fixtures/sample_analysis.json \\
        --out out/lucas-review.pdf

Brand tokens
------------
    Teal  (primary): #2BB5B2  — headings, gauges, accents
    Red   (CTA):     #f84455  — calls to action, highlights
    Ink   (body):    #1F2933
    Mist  (bg):      #F2F2F2
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import tempfile
import textwrap
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional

from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm, mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.platypus import (
    BaseDocTemplate, Flowable, Frame, Image, KeepInFrame, KeepTogether,
    NextPageTemplate, PageBreak, PageTemplate, Paragraph, Spacer, Table,
    TableStyle,
)


# ---------------------------------------------------------------------------
# Brand tokens
# ---------------------------------------------------------------------------

TEAL = HexColor("#2BB5B2")
TEAL_DARK = HexColor("#1F8B88")
TEAL_FAINT = HexColor("#E6F6F5")
RED = HexColor("#F84455")
INK = HexColor("#1F2933")
MUTED = HexColor("#667085")
MIST = HexColor("#F2F2F2")
GREEN = HexColor("#1FA85C")
AMBER = HexColor("#F5A623")
RED_SCORE = HexColor("#E64545")
WHITE = colors.white


PAGE_WIDTH, PAGE_HEIGHT = A4
MARGIN_X = 18 * mm
MARGIN_TOP = 22 * mm
MARGIN_BOTTOM = 28 * mm  # generous to clear the wave footer


# ---------------------------------------------------------------------------
# Paragraph styles
# ---------------------------------------------------------------------------

def _styles():
    s = getSampleStyleSheet()
    styles = {
        "h1": ParagraphStyle("h1", parent=s["Heading1"], fontName="Helvetica-Bold",
                              fontSize=28, leading=34, textColor=TEAL, spaceAfter=10),
        "h2": ParagraphStyle("h2", parent=s["Heading2"], fontName="Helvetica-Bold",
                              fontSize=18, leading=22, textColor=TEAL, spaceBefore=14,
                              spaceAfter=6),
        "h3": ParagraphStyle("h3", parent=s["Heading3"], fontName="Helvetica-Bold",
                              fontSize=13, leading=17, textColor=INK, spaceBefore=10,
                              spaceAfter=3),
        "eyebrow": ParagraphStyle("eyebrow", fontName="Helvetica-Bold", fontSize=9,
                                    leading=12, textColor=TEAL_DARK, spaceAfter=4),
        "body": ParagraphStyle("body", parent=s["BodyText"], fontName="Helvetica",
                                fontSize=10.5, leading=15, textColor=INK, spaceAfter=6),
        "muted": ParagraphStyle("muted", fontName="Helvetica", fontSize=9.5, leading=13,
                                 textColor=MUTED),
        "quote": ParagraphStyle("quote", fontName="Helvetica-Oblique", fontSize=10.5,
                                 leading=15, textColor=INK, leftIndent=10,
                                 borderPadding=4),
        "cover_title": ParagraphStyle("cover_title", fontName="Helvetica-Bold",
                                        fontSize=32, leading=38, textColor=WHITE,
                                        alignment=TA_LEFT),
        "cover_sub": ParagraphStyle("cover_sub", fontName="Helvetica", fontSize=14,
                                      leading=18, textColor=WHITE, alignment=TA_LEFT),
        "cover_meta": ParagraphStyle("cover_meta", fontName="Helvetica", fontSize=10,
                                       leading=14, textColor=WHITE, alignment=TA_LEFT),
        "cta": ParagraphStyle("cta", fontName="Helvetica-Bold", fontSize=11,
                               leading=14, textColor=WHITE, alignment=TA_CENTER),
        "code": ParagraphStyle("code", fontName="Helvetica", fontSize=10, leading=14,
                                 textColor=INK, backColor=MIST, borderPadding=8,
                                 spaceBefore=4, spaceAfter=8),
    }
    return styles


STYLES = _styles()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe(text: Any) -> str:
    if text is None:
        return ""
    s = str(text)
    # Lightweight escaping for Paragraph's XML parser.
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _p(text, style="body"):
    return Paragraph(_safe(text), STYLES[style])


def _score_color(score: Optional[float]) -> colors.Color:
    if score is None:
        return MUTED
    s = float(score)
    if s >= 80:
        return GREEN
    if s >= 60:
        return AMBER
    return RED_SCORE


def _normalise_category_score(score):
    """Platform category ratings arrive 0-5; dashboard scores arrive 0-100."""
    if score is None:
        return None
    s = float(score)
    return round(s * 20) if s <= 5.0 else round(s)


def _fetch_image(url: Optional[str]) -> Optional[str]:
    """Download a remote image to a temp file, return the path or None."""
    if not url:
        return None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Lucas/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read()
        suffix = ".jpg"
        if "png" in (resp.headers.get("Content-Type") or "").lower():
            suffix = ".png"
        tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        tmp.write(data)
        tmp.close()
        return tmp.name
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Custom flowables: score gauge, wave footer
# ---------------------------------------------------------------------------

class ScoreRing(Flowable):
    """Circular score dial with a centred number and a label underneath."""

    def __init__(self, score, label, size=42 * mm):
        super().__init__()
        self.score = score
        self.label = label
        self.size = size

    def wrap(self, aw, ah):
        return (self.size, self.size + 18)

    def draw(self):
        c = self.canv
        r = self.size / 2
        cx, cy = r, r + 12  # label sits under the ring
        # Background ring
        c.setStrokeColor(MIST)
        c.setLineWidth(4)
        c.circle(cx, cy, r - 3, stroke=1, fill=0)
        # Score arc
        if self.score is not None:
            pct = max(0, min(100, float(self.score))) / 100.0
            colour = _score_color(self.score)
            c.setStrokeColor(colour)
            c.setLineWidth(6)
            # ReportLab angles: 0° at east, counter-clockwise is positive.
            # We want the arc to start at 12 o'clock and sweep clockwise.
            c.arc(cx - r + 3, cy - r + 3, cx + r - 3, cy + r - 3,
                  startAng=90, extent=-360 * pct)
        # Centre text
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 16)
        txt = str(int(round(self.score))) if self.score is not None else "—"
        c.drawCentredString(cx, cy - 5, txt)
        c.setFont("Helvetica", 7.5)
        c.setFillColor(MUTED)
        c.drawCentredString(cx, cy - 16, "/ 100")
        # Label
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 8)
        c.drawCentredString(cx, 0, self.label.upper())


class TrafficLight(Flowable):
    """Small solid pill with a traffic-light colour and a short label."""

    def __init__(self, score, width=30 * mm, height=8 * mm):
        super().__init__()
        self.score = score
        self.width = width
        self.height = height

    def wrap(self, aw, ah):
        return (self.width, self.height)

    def draw(self):
        c = self.canv
        colour = _score_color(self.score)
        c.setFillColor(colour)
        c.setStrokeColor(colour)
        c.roundRect(0, 0, self.width, self.height, 3, stroke=0, fill=1)
        c.setFillColor(WHITE)
        c.setFont("Helvetica-Bold", 8)
        label = ("GREEN" if colour == GREEN else "AMBER" if colour == AMBER
                 else "RED" if colour == RED_SCORE else "—")
        c.drawCentredString(self.width / 2, self.height / 2 - 3, label)


class Checkbox(Flowable):
    """Empty square checkbox glyph drawn directly — avoids font coverage issues."""

    def __init__(self, size=3.2 * mm):
        super().__init__()
        self.size = size

    def wrap(self, aw, ah):
        return (self.size, self.size)

    def draw(self):
        c = self.canv
        c.setStrokeColor(INK)
        c.setFillColor(WHITE)
        c.setLineWidth(0.8)
        c.rect(0, 0, self.size, self.size, stroke=1, fill=1)


class ImpactChip(Flowable):
    def __init__(self, impact, width=22 * mm, height=6 * mm):
        super().__init__()
        self.impact = (impact or "").lower()
        self.width = width
        self.height = height

    def wrap(self, aw, ah):
        return (self.width, self.height)

    def draw(self):
        colour_map = {"high": RED, "medium": TEAL, "low": MUTED}
        c = self.canv
        col = colour_map.get(self.impact, MUTED)
        c.setFillColor(col)
        c.setStrokeColor(col)
        c.roundRect(0, 0, self.width, self.height, 3, stroke=0, fill=1)
        c.setFillColor(WHITE)
        c.setFont("Helvetica-Bold", 7)
        c.drawCentredString(self.width / 2, self.height / 2 - 2.4,
                             (self.impact or "—").upper())


# ---------------------------------------------------------------------------
# Page decoration: teal wave at bottom with white footer text
# ---------------------------------------------------------------------------

def draw_wave_footer(c: pdfcanvas.Canvas, page_num: int, total_pages: Optional[int] = None):
    """Draw the teal wave decoration + white page number on every page."""
    w, h = PAGE_WIDTH, PAGE_HEIGHT
    wave_h = 20 * mm

    c.saveState()
    c.setFillColor(TEAL)
    c.setStrokeColor(TEAL)
    # Fill a wave shape across the bottom. Path: start at bottom-left, line to
    # (0, wave_h), bezier across, line to bottom-right, close.
    p = c.beginPath()
    p.moveTo(0, 0)
    p.lineTo(0, wave_h)
    p.curveTo(w * 0.25, wave_h + 12 * mm,
              w * 0.55, wave_h - 10 * mm,
              w * 0.75, wave_h + 4 * mm)
    p.curveTo(w * 0.88, wave_h + 10 * mm, w, wave_h - 6 * mm, w, wave_h - 4 * mm)
    p.lineTo(w, 0)
    p.close()
    c.drawPath(p, stroke=0, fill=1)

    # Soft overlay wave (darker teal) for depth
    c.setFillColor(TEAL_DARK)
    p2 = c.beginPath()
    p2.moveTo(0, 0)
    p2.lineTo(0, wave_h * 0.55)
    p2.curveTo(w * 0.3, wave_h * 0.95,
               w * 0.55, wave_h * 0.25,
               w * 0.8, wave_h * 0.6)
    p2.curveTo(w * 0.92, wave_h * 0.78, w, wave_h * 0.35, w, wave_h * 0.4)
    p2.lineTo(w, 0)
    p2.close()
    c.drawPath(p2, stroke=0, fill=1)

    # Footer text (white, sitting inside the wave band)
    c.setFillColor(WHITE)
    c.setFont("Helvetica", 8.5)
    c.drawString(MARGIN_X, 7 * mm, "HelloHosty · AI Listing Review")
    footer_right = f"Page {page_num}" + (f" of {total_pages}" if total_pages else "")
    c.drawRightString(w - MARGIN_X, 7 * mm, footer_right)
    c.restoreState()


# ---------------------------------------------------------------------------
# Document template — adds wave footer to every page
# ---------------------------------------------------------------------------

class LucasDocTemplate(BaseDocTemplate):
    """Doc template that paints the teal wave + page number on every page."""

    def __init__(self, filename, **kwargs):
        super().__init__(filename, pagesize=A4,
                          leftMargin=MARGIN_X, rightMargin=MARGIN_X,
                          topMargin=MARGIN_TOP, bottomMargin=MARGIN_BOTTOM,
                          title=kwargs.pop("title", "AI Listing Review"),
                          author="HelloHosty", **kwargs)

        cover_frame = Frame(0, 0, PAGE_WIDTH, PAGE_HEIGHT,
                             leftPadding=0, rightPadding=0,
                             topPadding=0, bottomPadding=0, id="cover")
        body_frame = Frame(MARGIN_X, MARGIN_BOTTOM,
                             PAGE_WIDTH - 2 * MARGIN_X,
                             PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM,
                             id="body")
        self.addPageTemplates([
            PageTemplate(id="cover", frames=cover_frame,
                          onPage=self._cover_page),
            PageTemplate(id="body", frames=body_frame,
                          onPage=self._body_page),
        ])
        self._page_count = 0

    def _cover_page(self, c, doc):
        self._page_count += 1
        # Cover has its own background — no wave.
        pass

    def _body_page(self, c, doc):
        self._page_count += 1
        draw_wave_footer(c, self._page_count)


# ---------------------------------------------------------------------------
# Section builders
# ---------------------------------------------------------------------------

def build_cover(scraped: dict, analysis: dict) -> list:
    """The cover page is drawn onto the canvas directly. We still need a Frame
    flowable to trigger page layout, so we return a single DrawableCover."""
    return [DrawableCover(scraped, analysis), NextPageTemplate("body"), PageBreak()]


class DrawableCover(Flowable):
    """Full-bleed cover that paints itself directly onto the canvas."""

    def __init__(self, scraped, analysis):
        super().__init__()
        self.scraped = scraped
        self.analysis = analysis

    def wrap(self, aw, ah):
        return (PAGE_WIDTH, PAGE_HEIGHT)

    def draw(self):
        c = self.canv
        w, h = PAGE_WIDTH, PAGE_HEIGHT

        # Full-bleed hero image as background, with a teal overlay.
        hero_url = ((self.scraped.get("images") or {}).get("hero_cloudinary_url")
                    or (self.scraped.get("images") or {}).get("hero_image_url"))
        hero_path = _fetch_image(hero_url)
        try:
            if hero_path:
                c.drawImage(hero_path, 0, h * 0.42, width=w, height=h * 0.58,
                             preserveAspectRatio=True, anchor="c", mask="auto")
            else:
                c.setFillColor(HexColor("#E6F6F5"))
                c.rect(0, h * 0.42, w, h * 0.58, stroke=0, fill=1)
        except Exception:
            c.setFillColor(HexColor("#E6F6F5"))
            c.rect(0, h * 0.42, w, h * 0.58, stroke=0, fill=1)

        # Teal gradient-ish band covering the bottom half.
        c.setFillColor(TEAL)
        c.rect(0, 0, w, h * 0.46, stroke=0, fill=1)
        c.setFillColor(TEAL_DARK)
        c.rect(0, 0, w, h * 0.12, stroke=0, fill=1)

        # HelloHosty wordmark (top-left), Lucas badge (top-right).
        c.setFillColor(WHITE)
        c.setFont("Helvetica-Bold", 12)
        c.drawString(MARGIN_X, h - 14 * mm, "HelloHosty")
        c.setFillColor(TEAL)
        c.roundRect(w - MARGIN_X - 36 * mm, h - 16 * mm, 36 * mm, 9 * mm, 2, stroke=0, fill=1)
        c.setFillColor(WHITE)
        c.setFont("Helvetica-Bold", 9)
        c.drawCentredString(w - MARGIN_X - 18 * mm, h - 12.5 * mm, "LISTING REVIEW")

        # Title stack
        title_y = h * 0.38
        c.setFillColor(WHITE)
        c.setFont("Helvetica-Bold", 11)
        c.drawString(MARGIN_X, title_y + 18 * mm, "AN AI LISTING REVIEW BY HELLOHOSTY")
        c.setFont("Helvetica-Bold", 28)
        # Wrap property name to max two lines.
        prop = (self.analysis.get("property_name")
                 or (self.scraped.get("property") or {}).get("name")
                 or "Your listing")
        for i, line in enumerate(textwrap.wrap(prop, 28)[:2]):
            c.drawString(MARGIN_X, title_y - i * 12 * mm, line)

        # Meta row at the bottom
        meta_y = 40 * mm
        host = self.scraped.get("host") or {}
        c.setFillColor(WHITE)
        c.setFont("Helvetica", 10)
        c.drawString(MARGIN_X, meta_y + 16 * mm, f"Host  ·  {host.get('name', '—')}"
                      + (" · Superhost" if host.get("superhost") else ""))
        c.drawString(MARGIN_X, meta_y + 10 * mm, f"Platform  ·  {self.analysis.get('platform', 'airbnb').capitalize()}")
        c.drawString(MARGIN_X, meta_y + 4 * mm,
                      f"Generated  ·  {self.analysis.get('review_date') or datetime.utcnow().date().isoformat()}")

        # Host avatar circle (top-right of teal band)
        prof_url = ((self.scraped.get("images") or {}).get("profile_cloudinary_url")
                    or host.get("profile_image_url"))
        prof_path = _fetch_image(prof_url)
        if prof_path:
            size = 22 * mm
            x = w - MARGIN_X - size
            y = meta_y + 2 * mm
            # Circular clip
            c.saveState()
            p = c.beginPath()
            p.circle(x + size / 2, y + size / 2, size / 2)
            c.clipPath(p, stroke=0, fill=0)
            try:
                c.drawImage(prof_path, x, y, width=size, height=size,
                             preserveAspectRatio=True, anchor="c", mask="auto")
            except Exception:
                pass
            c.restoreState()
            c.setStrokeColor(WHITE)
            c.setLineWidth(2)
            c.circle(x + size / 2, y + size / 2, size / 2, stroke=1, fill=0)


def build_dashboard(analysis: dict) -> list:
    scores = analysis.get("scores") or {}
    story: list = []
    story.append(_p("Dashboard", "h1"))
    story.append(_p(
        "A single-page read on the health of your listing. Green is good, "
        "amber is worth a look, red needs attention this week.", "muted"))
    story.append(Spacer(1, 10))

    # Top row: only show category scores that have actual data.
    all_dash_fields = [("Content", "content"), ("Photos", "photos"),
                        ("Pricing", "pricing"), ("Amenities", "amenities"),
                        ("SEO", "seo"), ("Response", "response")]
    dash_fields = [(label, key) for label, key in all_dash_fields
                   if _normalise_category_score(scores.get(key)) is not None]
    overall = _normalise_category_score(scores.get("overall"))

    # Big overall ring + tagline
    header_tbl = Table(
        [[ScoreRing(overall, "Overall", size=52 * mm),
          Paragraph(
              f"<b>Overall listing score: {overall if overall is not None else '—'}/100</b><br/>"
              f"Based on {_safe(analysis.get('total_reviews') or 0)} reviews "
              f"and a 360° audit of your content, photos, pricing, amenities, "
              f"SEO and host response. ",
              STYLES["body"])]],
        colWidths=[60 * mm, None],
    )
    header_tbl.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(header_tbl)
    story.append(Spacer(1, 14))

    # Category score rings — only render those with data, in rows of 3
    if dash_fields:
        row = []
        for label, key in dash_fields:
            s = _normalise_category_score(scores.get(key))
            row.append(ScoreRing(s, label))
        # Pad to multiple of 3 for clean grid layout
        while len(row) % 3 != 0:
            row.append(Paragraph("", STYLES["body"]))
        cells = [row[i:i+3] for i in range(0, len(row), 3)]
        col_w = (PAGE_WIDTH - 2 * MARGIN_X) / 3
        dash_grid = Table(cells, colWidths=[col_w] * 3)
        dash_grid.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 10),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ]))
        story.append(dash_grid)
    story.append(Spacer(1, 10))

    # ── Guest reviews headline — overall score + count ──
    total_reviews = analysis.get("total_reviews") or 0
    overall_rating = analysis.get("overall_rating")

    if total_reviews > 0 and overall_rating is not None:
        # Build a prominent guest-score banner
        star_display = f"{float(overall_rating):.1f}"
        filled_stars = int(round(float(overall_rating)))
        stars_str = "★" * filled_stars + "☆" * (5 - filled_stars)
        score_banner = Table([[
            Paragraph(
                f"<font size='24' color='#2BB5B2'><b>{star_display}</b></font>"
                f"<font size='12' color='#667085'> / 5</font>",
                STYLES["body"]),
            Paragraph(
                f"<font size='14' color='#F5A623'>{stars_str}</font><br/>"
                f"<font size='10' color='#667085'>Based on <b>{total_reviews}</b> guest review{'s' if total_reviews != 1 else ''}</font>",
                STYLES["body"]),
        ]], colWidths=[50 * mm, None])
        score_banner.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("BACKGROUND", (0, 0), (-1, -1), TEAL_FAINT),
            ("BOX", (0, 0), (-1, -1), 1, TEAL),
            ("LEFTPADDING", (0, 0), (-1, -1), 12),
            ("RIGHTPADDING", (0, 0), (-1, -1), 12),
            ("TOPPADDING", (0, 0), (-1, -1), 10),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ]))
        story.append(_p("Guest reviews", "h2"))
        story.append(score_banner)
        story.append(Spacer(1, 8))
    elif total_reviews > 0:
        story.append(_p(f"Guest reviews ({total_reviews} reviews)", "h2"))
    else:
        story.append(_p("Guest reviews", "h2"))

    # Guest-rating breakdown — only show if at least one category has data.
    breakdown_fields = [("Cleanliness", "cleanliness"), ("Accuracy", "accuracy"),
                         ("Check-in", "checkin"), ("Communication", "communication"),
                         ("Location", "location"), ("Value", "value")]
    has_any_breakdown = any(
        isinstance(scores.get(key), (int, float))
        for _, key in breakdown_fields
    )
    if has_any_breakdown:
        rows = [[
            Paragraph("<b>Category</b>", STYLES["body"]),
            Paragraph("<b>Guest rating</b>", STYLES["body"]),
            Paragraph("<b>Traffic light</b>", STYLES["body"]),
        ]]
        for label, key in breakdown_fields:
            raw = scores.get(key)
            if not isinstance(raw, (int, float)):
                continue  # Skip categories with no data
            pretty = f"{float(raw):.2f} / 5"
            rows.append([
                Paragraph(label, STYLES["body"]),
                Paragraph(pretty, STYLES["body"]),
                TrafficLight(_normalise_category_score(raw)),
            ])
        tbl = Table(rows, colWidths=[60 * mm, 60 * mm, 40 * mm])
        tbl.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), TEAL_FAINT),
            ("TEXTCOLOR", (0, 0), (-1, 0), TEAL_DARK),
            ("BOX", (0, 0), (-1, -1), 0.4, MIST),
            ("INNERGRID", (0, 0), (-1, -1), 0.4, MIST),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(KeepTogether([_p("Rating breakdown", "h3"), tbl]))
    elif total_reviews > 0:
        # Has reviews but no category breakdown — don't contradict
        story.append(_p("Detailed category ratings (cleanliness, accuracy, etc.) "
                         "were not available for this listing at the time of this report. "
                         "These breakdowns are provided by the platform once enough "
                         "ratings have been collected.", "muted"))

    # ── Review sentiment ──
    review_summary = analysis.get("review_sentiment_summary") or ""
    if review_summary.strip():
        if total_reviews > 0:
            story.append(_p("What guests are saying", "h3"))
        # Show first paragraph on dashboard; full version in content review
        first_para = review_summary.split("\n\n")[0].strip()
        story.append(_p(first_para))
        if len(review_summary.split("\n\n")) > 1:
            story.append(_p("Full review analysis continues in the Content Review section.", "muted"))
    elif total_reviews == 0:
        story.append(_p(
            "This listing currently has no guest reviews. Reviews are the single "
            "biggest trust signal for potential guests — without social proof, many "
            "travellers will scroll past even a well-written listing. Focus on "
            "securing your first bookings and encouraging every guest to leave a review."
        ))
    else:
        story.append(_p(
            "Review data was not available for analysis at the time of this report. "
            "Check your listing's review section directly on the platform."
        ))
    story.append(Spacer(1, 8))

    # Top 3 quick wins callout
    qws = (analysis.get("quick_wins") or [])[:3]
    if qws:
        qw_block = [_p("Top 3 quick wins", "h3")]
        for qw in qws:
            qw_block.append(Paragraph(
                f"<b>{_safe(qw.get('title'))}</b> "
                f"· <i>{_safe(qw.get('estimated_time'))}</i> "
                f"· impact: <b>{_safe((qw.get('expected_impact') or '').upper())}</b>",
                STYLES["body"],
            ))
        story.append(KeepTogether(qw_block))
    story.append(PageBreak())
    return story


def build_quick_wins(analysis: dict) -> list:
    story = [_p("Quick Wins", "h1"),
              _p("Ordered by expected impact. Each one can be done today.", "muted"),
              Spacer(1, 6)]
    qws = analysis.get("quick_wins") or []
    for i, qw in enumerate(qws, start=1):
        header = Paragraph(
            f"<font color='#2BB5B2'><b>{i:02d}</b></font>  "
            f"<b>{_safe(qw.get('title'))}</b>", STYLES["h3"])
        meta = Table([[
            ImpactChip(qw.get("expected_impact")),
            Paragraph(
                f"<i>Est. time:</i> {_safe(qw.get('estimated_time'))}",
                STYLES["muted"]),
        ]], colWidths=[26 * mm, None])
        meta.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        ]))
        block = KeepTogether([
            header,
            meta,
            Spacer(1, 2),
            _p(qw.get("description")),
            Spacer(1, 6),
        ])
        story.append(block)
    story.append(PageBreak())
    return story


def _char_count_label(text: str, limit: int) -> str:
    """Character limits are enforced silently by the Claude prompt — never surface
    character counts or limit information to the host in the PDF report."""
    return ""


# Airbnb character limits (researched April 2026)
AIRBNB_LIMITS = {
    "title": 50,
    "description": 500,
    "the_space": 500,
    "guest_access": 500,
    "other_things_to_note": 500,
    "neighbourhood": 500,
    "getting_around": 500,
}


def build_content_review(scraped: dict, analysis: dict) -> list:
    lq = analysis.get("listing_quality") or {}
    content = scraped.get("content") or {}
    story = [_p("Listing Content Review", "h1"),
              _p("Your copy, dissected section by section. Each rewritten section "
                  "is paste-ready — copy directly into your Airbnb listing editor.", "muted"),
              Spacer(1, 4)]

    # Title — show current vs optimised with character counts
    current_title = content.get("title") or "—"
    new_title = analysis.get("optimised_title") or current_title
    title_limit = AIRBNB_LIMITS["title"]
    story.append(_p("Title", "h2"))
    title_assessment = lq.get("title") or ""
    if title_assessment.strip():
        story.append(_p(title_assessment))
    current_chars = _char_count_label(current_title, title_limit)
    new_chars = _char_count_label(new_title, title_limit)
    tbl = Table([
        [Paragraph("<b>Current</b>", STYLES["body"]),
         Paragraph(_safe(current_title) + (f"  <font color='#667085'>({current_chars})</font>" if current_chars else ""),
                    STYLES["body"])],
        [Paragraph("<b>Optimised</b>", STYLES["body"]),
         Paragraph(f"<font color='#2BB5B2'><b>{_safe(new_title)}</b></font>"
                     + (f"  <font color='#667085'>({new_chars})</font>" if new_chars else ""),
                    STYLES["body"])],
    ], colWidths=[28 * mm, None])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), TEAL_FAINT),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOX", (0, 0), (-1, -1), 0.4, MIST),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, MIST),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(tbl)

    # Title alternatives (if analysis provides them)
    title_alts = analysis.get("title_alternatives") or []
    if title_alts:
        story.append(Spacer(1, 4))
        story.append(_p("Alternative titles", "h3"))
        alt_rows = [[
            Paragraph("<b>#</b>", STYLES["body"]),
            Paragraph("<b>Title</b>", STYLES["body"]),
        ]]
        for i, alt in enumerate(title_alts[:3], 1):
            alt_text = alt if isinstance(alt, str) else alt.get("text", str(alt))
            alt_rows.append([
                Paragraph(str(i), STYLES["body"]),
                Paragraph(_safe(alt_text), STYLES["body"]),
            ])
        alt_tbl = Table(alt_rows, colWidths=[12 * mm, None])
        alt_tbl.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), TEAL_FAINT),
            ("BOX", (0, 0), (-1, -1), 0.4, MIST),
            ("INNERGRID", (0, 0), (-1, -1), 0.4, MIST),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(alt_tbl)

    # Description — "About this place"
    desc_limit = AIRBNB_LIMITS["description"]
    desc_assessment = lq.get("description") or ""
    existing_desc = content.get("description") or ""
    optimised_desc = analysis.get("optimised_description") or ""
    # Only show this section if we have something meaningful to say
    if desc_assessment.strip() or existing_desc.strip() or optimised_desc.strip():
        story.append(_p("About this place", "h2"))
        if desc_assessment.strip():
            story.append(_p(desc_assessment))

        # Show existing description if available
        if existing_desc:
            story.append(_p("Your current description", "h3"))
            story.append(Paragraph(
                _safe(existing_desc[:300] + ("…" if len(existing_desc) > 300 else "")).replace("\n", "<br/>"),
                STYLES["muted"]))
            story.append(Spacer(1, 4))

        if optimised_desc.strip():
            _desc_cl = _char_count_label(optimised_desc, desc_limit)
            story.append(Paragraph(
                f"<b>Optimised version</b> — paste-ready"
                + (f" &nbsp; <font color='#667085'>({_desc_cl})</font>" if _desc_cl else ""),
                STYLES["h3"]))
            story.append(Paragraph(_safe(optimised_desc).replace("\n", "<br/>"), STYLES["code"]))
        elif not existing_desc:
            story.append(_p("No listing description was found on this listing. "
                             "Adding a compelling description is one of the highest-impact "
                             "changes you can make — see your quick wins above.", "muted"))

    # Space / guest access (if present) — with character counts
    space_limit = AIRBNB_LIMITS["the_space"]
    if analysis.get("optimised_space"):
        space_text = analysis["optimised_space"]
        _space_cl = _char_count_label(space_text, space_limit)
        story.append(Paragraph(
            f"<b>The space</b> — paste-ready"
            + (f" &nbsp; <font color='#667085'>({_space_cl})</font>" if _space_cl else ""),
            STYLES["h3"]))
        story.append(Paragraph(_safe(space_text).replace("\n", "<br/>"),
                                 STYLES["code"]))

    access_limit = AIRBNB_LIMITS["guest_access"]
    if analysis.get("optimised_guest_access"):
        access_text = analysis["optimised_guest_access"]
        _access_cl = _char_count_label(access_text, access_limit)
        story.append(Paragraph(
            f"<b>Guest access</b> — paste-ready"
            + (f" &nbsp; <font color='#667085'>({_access_cl})</font>" if _access_cl else ""),
            STYLES["h3"]))
        story.append(Paragraph(_safe(access_text).replace("\n", "<br/>"),
                                 STYLES["code"]))

    # Neighbourhood description
    neighbourhood_limit = AIRBNB_LIMITS["neighbourhood"]
    if analysis.get("optimised_neighbourhood"):
        neighbourhood_text = analysis["optimised_neighbourhood"]
        _neigh_cl = _char_count_label(neighbourhood_text, neighbourhood_limit)
        story.append(Paragraph(
            f"<b>The neighbourhood</b> — paste-ready"
            + (f" &nbsp; <font color='#667085'>({_neigh_cl})</font>" if _neigh_cl else ""),
            STYLES["h3"]))
        story.append(Paragraph(_safe(neighbourhood_text).replace("\n", "<br/>"),
                                 STYLES["code"]))

    # Getting around description
    getting_around_limit = AIRBNB_LIMITS["getting_around"]
    if analysis.get("optimised_getting_around"):
        getting_around_text = analysis["optimised_getting_around"]
        _around_cl = _char_count_label(getting_around_text, getting_around_limit)
        story.append(Paragraph(
            f"<b>Getting around</b> — paste-ready"
            + (f" &nbsp; <font color='#667085'>({_around_cl})</font>" if _around_cl else ""),
            STYLES["h3"]))
        story.append(Paragraph(_safe(getting_around_text).replace("\n", "<br/>"),
                                 STYLES["code"]))

    # Photos + host profile assessment — only show if we have assessments
    if lq.get("photos"):
        story.append(_p("Photos", "h2"))
        story.append(_p(lq["photos"]))
    if lq.get("host_profile"):
        story.append(_p("Host profile", "h2"))
        story.append(_p(lq["host_profile"]))

    # Review sentiment summary — ALWAYS show this section (reviews are critical)
    total_reviews = analysis.get("total_reviews") or 0
    summary = analysis.get("review_sentiment_summary") or ""
    if total_reviews > 0:
        story.append(_p(f"What guests are actually saying ({total_reviews} reviews)", "h2"))
    else:
        story.append(_p("Guest reviews", "h2"))
    if summary.strip():
        for para in summary.split("\n\n"):
            if para.strip():
                story.append(_p(para))
    elif total_reviews == 0:
        story.append(_p(
            "This listing currently has no guest reviews. This is a significant "
            "gap — reviews are the single biggest trust signal for potential guests. "
            "Without social proof, many travellers will scroll past even a "
            "well-written listing. Focus on securing your first few bookings "
            "(consider introductory pricing or reaching out to friends and family) "
            "and encourage every guest to leave a review after their stay."
        ))
    else:
        story.append(_p(
            "Review data was not available for analysis at the time of this report. "
            "Check your listing's review section directly on the platform."
        ))
    story.append(PageBreak())
    return story


def _normalise_missing_amenities(raw_missing: list) -> list[dict]:
    """Handle both old format (list of strings) and new format (list of dicts)."""
    out = []
    for item in (raw_missing or []):
        if isinstance(item, str):
            out.append({"amenity": item, "competitor_pct": None, "reason": None})
        elif isinstance(item, dict):
            out.append(item)
    return out


def build_amenities(scraped: dict, analysis: dict) -> list:
    current = scraped.get("amenities") or []
    missing_raw = analysis.get("missing_amenities") or []
    missing = _normalise_missing_amenities(missing_raw)
    lq = analysis.get("listing_quality") or {}

    # Skip the entire section if we have no amenity data at all
    amenity_assessment = lq.get("amenities") or ""
    if not current and not missing and not amenity_assessment.strip():
        return []

    story = [_p("Amenities Review", "h1")]
    if amenity_assessment.strip():
        story.append(_p(amenity_assessment, "muted"))
    story.append(Spacer(1, 6))

    # Current amenities list
    if current:
        story.append(_p(f"Currently listed ({len(current)})", "h3"))
        # Display in a compact two-column grid
        col_w = (PAGE_WIDTH - 2 * MARGIN_X - 8) / 2
        current_cells = []
        for i in range(0, len(current), 2):
            left = Paragraph("• " + _safe(current[i]), STYLES["body"])
            right = Paragraph("• " + _safe(current[i+1]), STYLES["body"]) if i+1 < len(current) else Paragraph("", STYLES["body"])
            current_cells.append([left, right])
        if current_cells:
            curr_tbl = Table(current_cells, colWidths=[col_w, col_w])
            curr_tbl.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), TEAL_FAINT),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]))
            story.append(curr_tbl)
        story.append(Spacer(1, 10))

    # Missing amenities with competitive context
    if missing:
        story.append(_p(f"Worth adding ({len(missing)})", "h3"))
        has_pct = any(m.get("competitor_pct") for m in missing)
        if has_pct:
            header = [
                Paragraph("<b>Amenity</b>", STYLES["body"]),
                Paragraph("<b>Top listings</b>", STYLES["body"]),
                Paragraph("<b>Why it matters</b>", STYLES["body"]),
            ]
            rows = [header]
            for m in missing:
                rows.append([
                    Paragraph(f"<font color='#F84455'>+</font> {_safe(m.get('amenity', ''))}", STYLES["body"]),
                    Paragraph(_safe(m.get("competitor_pct") or "—"), STYLES["body"]),
                    Paragraph(_safe(m.get("reason") or ""), STYLES["muted"]),
                ])
            tbl = Table(rows, colWidths=[50 * mm, 28 * mm, None], repeatRows=1, splitByRow=1)
            tbl.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), HexColor("#FFF1F2")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BOX", (0, 0), (-1, -1), 0.4, MIST),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, MIST),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]))
        else:
            # Simple list format (backward compatible)
            rows = []
            for m in missing:
                rows.append([Paragraph(
                    f"<font color='#F84455'>+</font> {_safe(m.get('amenity', ''))}",
                    STYLES["body"])])
            tbl = Table(rows, colWidths=[None])
            tbl.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), HexColor("#FFF1F2")),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
        story.append(tbl)
    else:
        story.append(_p("Your amenities list looks complete for this property type.", "muted"))

    story.append(PageBreak())
    return story


def build_pricing(scraped: dict, analysis: dict) -> list:
    pricing = scraped.get("pricing") or {}
    scores = analysis.get("scores") or {}
    nb = pricing.get("nightly_base")
    cur = pricing.get("currency") or ""
    pricing_score = _normalise_category_score(scores.get("pricing"))
    value_breakdown = scores.get("value")

    # Skip the entire pricing section if we have no meaningful pricing data
    has_price = nb is not None
    has_pricing_score = pricing_score is not None
    has_value_rating = isinstance(value_breakdown, (int, float))
    if not has_price and not has_pricing_score and not has_value_rating:
        # No pricing data at all — omit the section entirely
        return []

    story = [_p("Pricing Analysis", "h1"),
              _p("Current positioning and quick wins on rate and yield.", "muted"),
              Spacer(1, 4)]

    if has_price:
        story.append(_p("Current nightly rate", "h3"))
        story.append(Paragraph(
            f"<font size='22'><b>{_safe(cur)} {_safe(nb)}</b></font>",
            STYLES["body"],
        ))
    else:
        story.append(Paragraph(
            "<i>Pricing data was not publicly visible on this listing. This can happen "
            "with listings that use request-to-book or have dynamic pricing that "
            "requires selecting dates.</i>",
            STYLES["muted"],
        ))
        story.append(Spacer(1, 6))

    if has_pricing_score:
        story.append(Paragraph(
            f"Pricing score: <b>{pricing_score} / 100</b>. "
            "This is a rules-based read — not a full market comp. For a dynamic,"
            " always-on pricing engine, see HelloHosty's pricing tools.",
            STYLES["body"],
        ))

    if has_value_rating:
        story.append(_p("Guest 'value for money' perception", "h3"))
        story.append(Paragraph(
            f"Guests rate value at <b>{float(value_breakdown):.2f} / 5</b>. "
            + ("This is in line with the overall rating — pricing appears well-calibrated."
               if float(value_breakdown) >= (analysis.get("overall_rating") or 0)
               else "This trails the overall rating — a signal that guests love the stay but find it slightly dear."),
            STYLES["body"],
        ))

    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "<b>Soft next step.</b> HelloHosty's pricing stack feeds market signals, "
        "competitor rates and your calendar into one view. "
        "Come back for another review once your optimised listing has been live for 30 days.",
        STYLES["body"],
    ))
    story.append(PageBreak())
    return story


def build_next_steps(analysis: dict) -> list:
    story = [_p("Your Action Plan", "h1"),
              _p("Use this as a checklist. Knock out the quick wins this week, "
                  "then tackle the priority improvements over the next fortnight.",
                  "muted"),
              Spacer(1, 6)]

    # Checklist of quick wins + priority improvements
    items = [("Quick win · " + qw.get("title", ""), qw.get("expected_impact"))
              for qw in (analysis.get("quick_wins") or [])]
    items += [("Priority · " + pi.get("title", ""), "medium")
               for pi in (analysis.get("priority_improvements") or [])]
    rows = []
    for label, impact in items:
        rows.append([
            Checkbox(),
            Paragraph(_safe(label), STYLES["body"]),
            ImpactChip(impact),
        ])
    if rows:
        tbl = Table(rows, colWidths=[8 * mm, None, 26 * mm])
        tbl.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("BOX", (0, 0), (-1, -1), 0.4, MIST),
            ("INNERGRID", (0, 0), (-1, -1), 0.4, MIST),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(tbl)

    # CTA block
    story.append(Spacer(1, 14))
    story.append(Paragraph(
        "<b>Want us to review your other listings?</b>", STYLES["h3"]))
    story.append(Paragraph(
        "Get another free review at <font color='#F84455'><b>lucas.hellohosty.com</b></font> "
        "— delivered in minutes.",
        STYLES["body"]))
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "<b>Turn your review into results.</b> The listing review is one piece of HelloHosty's "
        "AI team — alongside Alina (guest communications) and Operations Success (workflow monitoring). "
        "Together they run the day-to-day of your short-stay business so you can focus on growth.",
        STYLES["body"]))
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        "<b>Questions?</b> Reply to this email or write to "
        "<font color='#2BB5B2'><b>lucas@hellohosty.com</b></font>.",
        STYLES["body"]))
    return story


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build_pdf(scraped: dict, analysis: dict, out_path: str) -> str:
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    doc = LucasDocTemplate(out_path, title=f"AI Listing Review · {analysis.get('property_name', '')}")

    story: list = []
    story += build_cover(scraped, analysis)
    story += build_dashboard(analysis)
    story += build_quick_wins(analysis)
    story += build_content_review(scraped, analysis)
    story += build_amenities(scraped, analysis)
    story += build_pricing(scraped, analysis)
    story += build_next_steps(analysis)

    doc.build(story)
    return out_path


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Generate a Lucas listing-review PDF.")
    ap.add_argument("--scraped", required=True, help="Phase 1 scraped JSON path.")
    ap.add_argument("--analysis", required=True, help="Phase 2 analysis JSON path.")
    ap.add_argument("--out", required=True, help="Output PDF path.")
    args = ap.parse_args(argv)

    with open(args.scraped, encoding="utf-8") as f:
        scraped = json.load(f)
    with open(args.analysis, encoding="utf-8") as f:
        wrapped = json.load(f)
    # Phase 2 wraps the analysis under {"status": "success", "analysis": {...}}
    analysis = wrapped.get("analysis", wrapped)

    out = build_pdf(scraped, analysis, args.out)
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
