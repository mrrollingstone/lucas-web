# Lucas web — Next.js landing page + API

Vercel-hosted Next.js 14 (App Router) project. Two landing pages share a
single `ReviewForm` component; two API routes bridge to the n8n pipeline on
the VPS.

## Routes

| Path | Purpose |
|------|---------|
| `/` | Redirects to `/review` |
| `/review` | Public landing page (first review free; otherwise Stripe) |
| `/review/member` | HelloHosty member landing page (member discount via coupon — £10/$13.50/€11.50 base price) |
| `/review/confirmation` | "We're on it" success screen |
| `POST /api/submit` | Validates, checks first-time, forwards to n8n or Stripe |
| `POST /api/stripe/webhook` | Stripe `checkout.session.completed` → n8n |

## Dev

```bash
cd web
cp .env.example .env.local        # fill in secrets
npm install
npm run dev
```

## Landing-page design

The V6 design is locked. This scaffold uses a minimal Tailwind layout so the
final HTML can be pasted into `src/components/ReviewForm.tsx` without
changing the submit logic — all state and fetch calls live in that component.

When the V6 HTML is ready:

1. Paste the Step 1 (URL input) block into the `{step >= 1}` branch.
2. Paste the Step 2 (loading + email capture) block into `{step >= 2}`.
3. Keep the existing `onSubmit`, `setStep`, `submit()` wiring intact.
