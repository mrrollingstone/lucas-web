-- 0001_lucas_submissions.sql
--
-- Introduces the repeat-review gate for Lucas.
--
-- lucas_submissions    one row per email; tracks how many reviews we've delivered
-- stripe_event_log     idempotency log for the Stripe webhook
--
-- The IP / fingerprint columns on lucas_submissions are deliberately unused for
-- now — they exist so the next iteration (abuse detection beyond email) can
-- populate them without another migration.
--
-- Run once against the Vercel Postgres database pointed to by DATABASE_URL.

CREATE TABLE IF NOT EXISTS lucas_submissions (
  email              TEXT        PRIMARY KEY,
  first_seen         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_review_at     TIMESTAMPTZ,
  reviews_delivered  INT         NOT NULL DEFAULT 0,
  is_hh_member       BOOLEAN     DEFAULT FALSE,
  hh_checked_at      TIMESTAMPTZ,
  last_ip_hash       TEXT,
  fingerprint_hash   TEXT
);

CREATE INDEX IF NOT EXISTS idx_lucas_submissions_last_review_at
  ON lucas_submissions (last_review_at);

-- Webhook idempotency — we store every Stripe event id we've acted on so a
-- replay doesn't trigger a duplicate PDF delivery.
CREATE TABLE IF NOT EXISTS stripe_event_log (
  event_id   TEXT        PRIMARY KEY,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
