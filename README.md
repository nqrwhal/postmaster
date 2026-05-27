# Postmaster

Static tracking dashboard for USPS, UPS, and FedEx. Calls the Postmaster API Cloudflare Worker and renders normalized results.

Live: https://postmaster.mayufei.com

## What it does

- Paste one or many tracking numbers (newlines, commas, or spaces)
- Auto-detects carrier per row (override per row if needed)
- Sequentially tracks each number with an invisible Cloudflare Turnstile token per request
- Shows status, ETA, and a clickable timeline per package
- Caches recent lookups in localStorage
- Exports the current batch to CSV

## Stack

- Static HTML/CSS/JS, no build step
- Cloudflare Pages for hosting
- Cloudflare Turnstile (invisible mode) for browser auth
- Postmaster API Worker (see [SPEC.md](./SPEC.md)) for tracking data

## Local development

```bash
cd frontend
python3 -m http.server 8000
# open http://localhost:8000
```

Turnstile must have `localhost` listed as an allowed hostname for the site key to validate during local dev. Configure in the Cloudflare Turnstile dashboard.

## Deploy

Cloudflare Pages:

- Connect this repo
- Build command: `exit 0`
- Build output directory: `frontend`
- Custom domain: `postmaster.mayufei.com`

The Worker's `ALLOWED_ORIGINS` must include any domain that calls it (Pages previews, custom domain, localhost). See `src/config.ts` in the Worker repo.

## Files

```
frontend/
  index.html      Layout, loads Turnstile script
  app.js          Parsing, carrier detect, Turnstile, API calls, render
  styles.css      Dark theme, responsive
  _headers        Security headers + CSP for Cloudflare Pages
SPEC.md           API contract (mirrored from the Worker repo)
```

## Notes

- The Turnstile **site key** in `app.js` is public by design. Only the Worker holds the secret.
- No bearer token is ever embedded in static files. Server-to-server callers of the API use bearer auth; browsers use Turnstile.
