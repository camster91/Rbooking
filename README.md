# rbooking

Event booking app for Rotman AV Services.

Current release: **v1.2.0** — see [CHANGELOG.md](CHANGELOG.md).

## Quick Start

```bash
git clone https://github.com/camster91/rotman-av-booking.git
cd rotman-av-booking
npm install
cp .env.example .env   # then set AUTH_PASS, ADMIN_PASS and your SMTP settings
npm start
```

Visit http://localhost:3000 and log in with your `AUTH_USER` / `AUTH_PASS` from `.env`.
AV staff manage bookings at http://localhost:3000/admin with `ADMIN_USER` / `ADMIN_PASS`.

## Configuration

Set your SMTP password (required for emails):

```bash
export SMTP_PASSWORD="your_titan_password"
npm start
```

Or create a `.env` file:

```env
SMTP_HOST=smtp.titan.email
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USERNAME=requests@rotmanav.ca
SMTP_PASSWORD=your_password_here
EMAIL_TO=requests@rotmanav.ca
BASE_URL=http://localhost:3000
AUTH_USER=admin
AUTH_PASS=your_auth_password
ADMIN_USER=av-admin
ADMIN_PASS=your_admin_password
```

## Features

- ✅ **Multi-step booking form** (4 steps) with inline errors and an edit-from-review step
- ✅ **Event spaces**: Full Hall, 1/3, 2/3, Fleck Atrium
- ✅ **Time presets**: Morning, Afternoon, Evening, Full Day
- ✅ **Recording options**: None, Basic, Live Web
- ✅ **File uploads** (images/videos up to 50MB, deleted 90 days after the event)
- ✅ **Bookings saved in a database** (SQLite file in `data/`)
- ✅ **Admin page** (`/admin`): review, approve, decline and cancel bookings
- ✅ **Double-booking check**: shows taken times on the form, blocks clashes with approved bookings, flags clashes with pending ones
- ✅ **Emails**: staff get each request with a calendar hold; requesters get a confirmation, then an approve/decline/cancel email (approved ones include a calendar invite)
- ✅ **Rate limiting** (10 bookings and 30 failed logins per 15 minutes per IP)
- ✅ **Input validation & XSS protection**
- ✅ **Two logins**: shared form login and a separate AV staff login
- ✅ **Health check endpoint**
- ✅ **Full test suite**

### Double-booking rules

A booking holds its space from **registration** until **shutdown**. All three Event Hall set-ups (full, 1/3, 2/3) count as the same room, so any two hall bookings that overlap clash. Fleck Atrium is separate. Back-to-back bookings (one ends at 12:00, the next starts at 12:00) are fine. To change which spaces clash, edit `SPACE_GROUPS` in `lib/bookings.js`.

## API

### Submit Booking
```
POST /api/submit
Authorization: Basic auth (your AUTH_USER:AUTH_PASS)
Content-Type: multipart/form-data

Fields:
- event-space: full, one-third, two-thirds, fleck-atrium
- event-name: Event title
- event-date: YYYY-MM-DD ("May 1, 2026" also accepted - this is what the form sends)
- person-of-contact: Contact name
- email-address: Contact email
- registration-time: HH:MM
- event-start-time: HH:MM
- presentation-end-time: HH:MM
- shutdown: HH:MM
- recording-option: none, basic-recording, live-web-recording
- cc-number: Cost Center (optional)
- cfc-number: CFC (optional)
- other-notes: Notes (optional)
- media-upload: File (optional)
```

Returns `{ success, id, message, confirmationSent }`. Returns `409` if the space is already booked (approved) at that time.

### Availability
```
GET /api/availability?date=YYYY-MM-DD&space=full
```
Lists taken times for that day (only the space, times and status - no names).

### Admin (staff login)
```
GET  /api/admin/bookings?scope=upcoming|past|all&status=pending
POST /api/admin/bookings/:id/status   (JSON: { "status": "approved" | "declined" | "cancelled", "note": "optional" })
```

### Health Check
```
GET /health
```

## Development

```bash
npm test          # Run the test suite
npm run lint      # Lint code
npm run lint:fix  # Auto-fix linting
```

## Docker Deployment

The image sets `NODE_ENV=production`, so the app refuses to start unless `AUTH_PASS`, `ADMIN_PASS`, `SMTP_HOST` and `SMTP_PASSWORD` are set — it fails loudly instead of silently losing bookings.

Mount `/app/data` on a volume: it holds the bookings database. Without it, bookings are lost when the container is replaced.

```bash
docker build -t rbooking .
docker run -p 3000:3000 \
  --restart unless-stopped \
  -v rotman-av-uploads:/app/uploads \
  -v rotman-av-data:/app/data \
  -e AUTH_USER=admin \
  -e AUTH_PASS="set_a_strong_password" \
  -e ADMIN_USER=av-admin \
  -e ADMIN_PASS="set_another_strong_password" \
  -e BASE_URL="https://your-deployment.example.com" \
  -e SMTP_PASSWORD="your_password" \
  rbooking
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | Server port | 3000 |
| NODE_ENV | production in the Docker image (enables fail-fast guards) | development |
| SMTP_HOST | SMTP server (required in production) | - |
| SMTP_PORT | SMTP port | 587 |
| SMTP_USERNAME | Email address | requests@rotmanav.ca |
| SMTP_PASSWORD | Email password | - |
| EMAIL_TO | Recipient email | requests@rotmanav.ca |
| BASE_URL | Public URL | http://localhost:3000 |
| AUTH_USER | Auth username | admin |
| AUTH_PASS | Auth password (required in production) | development default only |
| ADMIN_USER | AV staff username for `/admin` | av-admin |
| ADMIN_PASS | AV staff password (required in production) | development default only |
| DATA_DIR | Folder for the bookings database | ./data |
| UPLOAD_RETENTION_DAYS | Delete uploads this many days after the event | 90 |
| TRUST_PROXY | Set (e.g. `1`) when behind a reverse proxy, so rate limits are per user | - |

## License

Proprietary - University of Toronto Rotman School of Management
