# Changelog

## v1.2.0 — 2026-10-02

### Added
- **Bookings database** — every request is saved (SQLite in `data/`), so nothing lives only in an inbox.
- **Admin page** at `/admin` (separate `ADMIN_USER` / `ADMIN_PASS` login) to review, approve, decline and cancel bookings, with search and clash warnings.
- **Double-booking check** — the form shows times already taken; a request that clashes with an approved booking is refused, and one that clashes with a pending request is flagged for staff. Approving a booking that clashes with an approved one is blocked.
- **Emails to the requester** — a confirmation when they submit, then an email when the booking is approved (with calendar invite), declined, or cancelled (with a calendar cancel).
- Staff calendar entries now start as tentative and update when a booking is approved or removed.
- Failed-login limit (30 per 15 minutes per IP).
- Uploaded files are deleted 90 days after the event (`UPLOAD_RETENTION_DAYS`), and files from rejected submissions are deleted straight away.

### Changed
- Docker image moved to Node 22 (Node 20 is end-of-life); Node 20+ is now required.
- **`ADMIN_PASS` is now required in production** — the app won't start without it.
- Uploaded files can only be opened with the staff login, and file names are random.
- Event dates in the past are rejected; space and recording option must be valid choices.

### Booking form UI
- Fixed: the form had no inner padding, so fields touched the card edges.
- Fixed: space and recording cards showed tiny uppercase grey text.
- Fixed: the progress line ran past the last step; steps now have names.
- Fixed: time-picker icons were black on the dark background.
- Errors now show next to each field instead of pop-up alerts; email format, time order and budget numbers are checked before moving on.
- The review step shows budget numbers and the attached file, with Edit links.
- Keyboard focus is visible on the choice cards and upload box; labels are linked to their fields.
- The success message shows the request number and says it isn't confirmed yet.
- CDN libraries are pinned to fixed versions.


### Fixed
- **Calendar invites** — `ORGANIZER`/`ATTENDEE` used `CN:` instead of `CN=`, which made the invite invalid for strict calendar apps.
- **Docker healthcheck** — it hit `/` without credentials, got 401, and marked the container unhealthy forever. It now hits `/health`, which no longer needs a login.
- **Upload errors** — a too-big or wrong-type file now returns a JSON message the form can show, instead of an HTML error page (which the form showed as "check your connection").

### Security
- The app no longer serves its whole folder as static files (source, `package.json`, `Dockerfile`, `node_modules`).
- Event space and recording option are HTML-escaped in the staff email (unknown values were echoed raw).
- Upload type check is now exact (it was a substring match, so `.mp4html` passed).
- New `.dockerignore` keeps a local `.env` and `node_modules` out of the image.
- Optional `TRUST_PROXY` setting so rate limiting works per user behind a reverse proxy.

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