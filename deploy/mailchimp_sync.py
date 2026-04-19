"""
Lucas — Phase 4: Mailchimp sync
================================

Tagging + drip-campaign entry logic. Intended to be called from n8n as a
subprocess step, but also usable as a library.

Tags managed:
  - listing-review-received   (every user who got at least one review)
  - listing-review-lead       (public landing-page entry)
  - listing-review-paid       (completed a Stripe purchase)
  - hellohosty-user           (known HelloHosty customer)

Anti-duplication: before adding a contact to a drip, check whether they are
already in an active Lucas or Guidebook drip — if yes, tag + deliver report
but skip the drip entry.

Requires ``mailchimp_marketing`` (``pip install mailchimp-marketing``) and env:
  MAILCHIMP_API_KEY=abc123-us21
  MAILCHIMP_SERVER_PREFIX=us21
  MAILCHIMP_AUDIENCE_ID=<audience id>
"""
from __future__ import annotations

import hashlib
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal


def _load_env() -> None:
    """Load /opt/lucas/.env into os.environ if MAILCHIMP_API_KEY isn't set."""
    if os.environ.get("MAILCHIMP_API_KEY"):
        return  # already loaded (e.g. via systemd EnvironmentFile)
    env_path = Path(os.environ.get("LUCAS_BASE_DIR", "/opt/lucas")) / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("'\"")  # strip optional quotes
        if key and key not in os.environ:
            os.environ[key] = value


_load_env()


Tag = Literal[
    "listing-review-received",
    "listing-review-lead",
    "listing-review-paid",
    "hellohosty-user",
]

# These are Mailchimp automation trigger tags. Adding a contact to one of
# these tags should start the associated workflow. Configure in Mailchimp UI.
DRIP_TRIGGER_TAG = "lucas-drip-start"
ACTIVE_DRIP_TAGS = {"lucas-drip-active", "guidebook-drip-active"}


@dataclass
class Contact:
    email: str
    first_name: str = ""
    last_name: str = ""
    is_hh_user: bool = False
    source: Literal["landing", "guidebook", "hh-upsell"] = "landing"


def _subscriber_hash(email: str) -> str:
    return hashlib.md5(email.strip().lower().encode()).hexdigest()


def _client():
    try:
        from mailchimp_marketing import Client
    except ImportError as e:
        raise RuntimeError(
            "The `mailchimp_marketing` package is not installed."
        ) from e
    api_key = os.environ["MAILCHIMP_API_KEY"]
    prefix = os.environ.get("MAILCHIMP_SERVER_PREFIX") or api_key.split("-")[-1]
    c = Client()
    c.set_config({"api_key": api_key, "server": prefix})
    return c


def _audience_id() -> str:
    return os.environ.get("MAILCHIMP_AUDIENCE_ID") or os.environ["MAILCHIMP_LIST_ID"]


def upsert_contact(contact: Contact) -> dict:
    """Ensure the contact exists and has baseline merge fields set."""
    mc = _client()
    h = _subscriber_hash(contact.email)
    body = {
        "email_address": contact.email.lower(),
        "status_if_new": "subscribed",
        "merge_fields": {
            "FNAME": contact.first_name or "",
            "LNAME": contact.last_name or "",
        },
    }
    return mc.lists.set_list_member(_audience_id(), h, body)


def get_active_tags(email: str) -> set[str]:
    mc = _client()
    h = _subscriber_hash(email)
    try:
        resp = mc.lists.get_list_member_tags(_audience_id(), h)
    except Exception:
        return set()
    return {t["name"] for t in (resp.get("tags") or [])}


def add_tags(email: str, tags: list[Tag | str]) -> None:
    mc = _client()
    h = _subscriber_hash(email)
    mc.lists.update_list_member_tags(
        _audience_id(), h,
        {"tags": [{"name": t, "status": "active"} for t in tags]},
    )


def remove_tags(email: str, tags: list[str]) -> None:
    mc = _client()
    h = _subscriber_hash(email)
    mc.lists.update_list_member_tags(
        _audience_id(), h,
        {"tags": [{"name": t, "status": "inactive"} for t in tags]},
    )


def handle_review_delivered(contact: Contact) -> dict:
    """Run the full post-delivery Mailchimp sync.

    Returns a report dict describing what was done so n8n can log it.
    """
    upsert_contact(contact)

    # Always tag these
    tags_to_add: list[str] = ["listing-review-received"]
    if contact.source == "landing":
        tags_to_add.append("listing-review-lead")
    if contact.is_hh_user:
        tags_to_add.append("hellohosty-user")

    # Drip entry gate: skip if they're already in a live drip
    active = get_active_tags(contact.email)
    drip_enter = not (active & ACTIVE_DRIP_TAGS) and not contact.is_hh_user
    if drip_enter:
        tags_to_add += [DRIP_TRIGGER_TAG, "lucas-drip-active"]

    add_tags(contact.email, tags_to_add)
    return {
        "email": contact.email,
        "tags_added": tags_to_add,
        "drip_entered": drip_enter,
        "already_in_drip": bool(active & ACTIVE_DRIP_TAGS),
    }


def handle_paid_purchase(contact: Contact) -> dict:
    """Call after a successful Stripe payment."""
    upsert_contact(contact)
    add_tags(contact.email, ["listing-review-paid", "listing-review-received"])
    return {"email": contact.email, "tags_added": ["listing-review-paid"]}


# ---------------------------------------------------------------------------
# CLI entrypoint for n8n Execute Command
# ---------------------------------------------------------------------------

def _cli() -> int:
    """Usage: python mailchimp_sync.py <action> <json_payload>"""
    import json
    if len(sys.argv) < 3:
        print(json.dumps({"status": "error",
                           "message": "usage: mailchimp_sync.py <action> <json>"}))
        return 1
    action = sys.argv[1]
    payload = json.loads(sys.argv[2])
    contact = Contact(
        email=payload["email"],
        first_name=payload.get("first_name", ""),
        last_name=payload.get("last_name", ""),
        is_hh_user=bool(payload.get("is_hh_user")),
        source=payload.get("source", "landing"),
    )
    try:
        if action == "review-delivered":
            result = handle_review_delivered(contact)
        elif action == "paid":
            result = handle_paid_purchase(contact)
        else:
            raise ValueError(f"unknown action: {action}")
        print(json.dumps({"status": "success", **result}))
        return 0
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
        return 1


if __name__ == "__main__":
    sys.exit(_cli())
