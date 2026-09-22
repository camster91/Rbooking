# Changelog

## v1.1.0 — 2026-09-22

Security and reliability release following a comprehensive code review.

### Fixed
- **No more silent booking loss** — in production the app now fails fast if SMTP is missing or unreachable, instead of quietly routing bookings to the disposable Ethereal test inbox. `/health` reports the real email mode and a `degraded` flag.
- **Calendar invites work** — ICS attachments are now RFC 5545-valid: both the form's `May 1, 2026` date format and API `YYYY-MM-DD` are accepted, `ORGANIZER`/`ATTENDEE` are emitted as proper single-line properties with RSVP, and all values are escaped and folded correctly.
- **Time validation hardened** — times must be strict 24-hour `HH:MM`, closing a gap that let malformed values through to staff emails.

### Security
- Production refuses to start on the published default auth password (`rotman2025`).
- Basic Auth parsing per RFC 7617 (passwords may contain colons), case-insensitive scheme, constant-time comparisons.
- `Dockerfile` sets `NODE_ENV=production`, enabling all fail-fast guards in the documented deployment.
- README and `.env.example` no longer publish credentials or a personal email address.

### Removed
- `email_sender.py` and `requirements.txt` — dead code from an earlier prototype (the module it imported does not exist; the app sends email via nodemailer).

### Tests
- Suite grown from 16 to 26 tests, with regressions for the date bug, ICS validity, newline injection, and authentication. All passing; lint clean.