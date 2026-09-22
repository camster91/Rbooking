# Rotman AV Booking System

A standalone event booking application for Rotman AV Services.

## Quick Start

```bash
git clone https://github.com/camster91/rotman-av-booking.git
cd rotman-av-booking
npm install
cp .env.example .env   # then set AUTH_PASS and your SMTP settings
npm start
```

Visit http://localhost:3000 and log in with your `AUTH_USER` / `AUTH_PASS` from `.env`.

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
```

## Features

- ✅ **Multi-step booking form** (4 steps)
- ✅ **Event spaces**: Full Hall, 1/3, 2/3, Fleck Atrium
- ✅ **Time presets**: Morning, Afternoon, Evening, Full Day
- ✅ **Recording options**: None, Basic, Live Web
- ✅ **File uploads** (images/videos up to 50MB)
- ✅ **Email notifications** via Titan SMTP
- ✅ **Rate limiting** (10 requests per 15 minutes)
- ✅ **Input validation & XSS protection**
- ✅ **Basic auth protection**
- ✅ **Health check endpoint**
- ✅ **Full test suite** (26 tests)

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

The image sets `NODE_ENV=production`, so the app refuses to start unless `AUTH_PASS`, `SMTP_HOST` and `SMTP_PASSWORD` are set — it fails loudly instead of silently losing bookings.

```bash
docker build -t rotman-av-booking .
docker run -p 3000:3000 \
  --restart unless-stopped \
  -v rotman-av-uploads:/app/uploads \
  -e AUTH_USER=admin \
  -e AUTH_PASS="set_a_strong_password" \
  -e BASE_URL="https://your-deployment.example.com" \
  -e SMTP_PASSWORD="your_password" \
  rotman-av-booking
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

## License

Proprietary - University of Toronto Rotman School of Management
