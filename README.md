# rbooking

Event booking app for Rotman AV Services, running on **Cloudflare Workers** (free plan).

Current release: **v2.0.0** — see [CHANGELOG.md](CHANGELOG.md).

## What it does

- **Booking form** (4 steps) with inline errors, time presets, and an edit-from-review step
- **Spaces**: Event Hall (full, 1/3, 2/3) and Fleck Atrium. **Recording**: none, basic, live web
- **Double-booking check**: the form shows times already taken; a clash with an approved booking is refused, a clash with a pending one is flagged to staff
- **Admin page** (`/admin`, separate staff login): review, approve, decline, cancel, with a note to the requester
- **Emails** through your mail server (Titan): staff get each request with a calendar hold; requesters get a confirmation, then an approve/decline/cancel email (approved ones carry a calendar invite in Toronto time)
- **Uploads** (images/videos up to 50MB), staff-only, deleted 90 days after the event
- Two logins, cross-site and clickjacking protection, per-IP rate limits, a daily upload cap, budget-number rule for after-hours events

## How it runs on Cloudflare

| Piece | Cloudflare product | Free plan |
|---|---|---|
| App code (`src/`) | Workers | 100,000 requests/day |
| Pages (`public/`) | Workers static assets | Included |
| Bookings | D1 database | Daily read/write limits, far above what this app needs |
| Uploaded files | R2 storage | 10 GB |
| Rate limits | Workers rate limiting | Included |
| Daily upload cleanup | Cron trigger | Included |
| Email | Your SMTP server (Titan) over port 587 | — |

Cloudflare's own email sending only reaches arbitrary addresses on the paid plan, so email goes through your existing Titan mailbox instead.

## Deploy

You need a Cloudflare account and Node.js 20+.

```bash
npm install
npx wrangler login

# 1. Create the database and file storage (once)
npx wrangler d1 create rbooking          # copy the database_id it prints into wrangler.jsonc
npx wrangler r2 bucket create rbooking-uploads
npm run db:migrate                       # creates the tables

# 2. Set the secrets (each command asks for the value)
npx wrangler secret put AUTH_PASS        # shared login for the booking form
npx wrangler secret put ADMIN_PASS       # AV staff login for /admin
npx wrangler secret put SMTP_PASSWORD    # Titan mailbox password

# 3. Deploy
npm run deploy
```

The app is then live at **https://rotmanav.ca/book/** (set by `routes` and `BASE_PATH` in `wrangler.jsonc`; the rest of rotmanav.ca is not affected). The admin page is at https://rotmanav.ca/book/admin.

Until `AUTH_PASS` and `ADMIN_PASS` are set, every page answers "Not set up yet" — the app never runs without passwords.

## Settings

Non-secret settings live in `wrangler.jsonc` under `vars`:

| Variable | Description | Default |
|---|---|---|
| AUTH_USER | Booking form username | admin |
| ADMIN_USER | AV staff username for `/admin` | av-admin |
| EMAIL_TO | Where new requests are sent | requests@rotmanav.ca |
| SMTP_HOST / SMTP_PORT | Mail server (587 = STARTTLS, 465 = TLS) | smtp.titan.email / 587 |
| SMTP_USERNAME | Mailbox that sends the emails | requests@rotmanav.ca |
| UPLOAD_RETENTION_DAYS | Delete uploads this many days after the event | 90 |
| UPLOAD_DAILY_LIMIT_MB | Total uploads allowed per day, in MB | 1024 |
| BASE_PATH | Path the app lives under | /book |
| BASE_URL | Optional: public URL used in email links (defaults to the request's address + BASE_PATH) | — |

Secrets (set with `wrangler secret put`): `AUTH_PASS`, `ADMIN_PASS`, `SMTP_PASSWORD`.

### Double-booking rules

A booking holds its space from **registration** until **shutdown**. All three Event Hall set-ups count as one room, so any two hall bookings that overlap clash. Fleck Atrium is separate. Back-to-back bookings are fine. To change which spaces clash, edit `SPACE_GROUPS` in `src/validate.js`.

## API

All routes except `/health` need the Basic Auth login.

```
POST /api/submit                       booking (form fields below, form-encoded, multipart or JSON)
PUT  /api/uploads                      raw file body; headers Content-Type, Content-Length, X-File-Name
GET  /api/availability?date=YYYY-MM-DD&space=full
GET  /api/admin/bookings?scope=upcoming|past|all&status=pending      (staff)
GET  /api/admin/bookings/:id                                          (staff)
POST /api/admin/bookings/:id/status    JSON { "status": "approved"|"declined"|"cancelled", "note": "" } (staff)
GET  /health
```

Booking fields: `event-name`, `event-space` (full, one-third, two-thirds, fleck-atrium), `event-date` (YYYY-MM-DD or "May 1, 2026"), `person-of-contact`, `email-address`, `registration-time`, `event-start-time`, `presentation-end-time`, `shutdown` (HH:MM), `recording-option` (none, basic-recording, live-web-recording), optional `cc-number`, `cfc-number`, `other-notes`, `upload-key` (from `/api/uploads`).

## Development

```bash
cp .dev.vars.example .dev.vars   # local passwords; emails are printed, not sent
npm run db:migrate:local
npm run dev                      # http://localhost:8787/book/

npm test                         # tests run inside the Workers runtime
npm run lint
```

## License

Proprietary - University of Toronto Rotman School of Management
