# Rotman AV Booking System

A standalone event booking application for Rotman AV Services.

## Quick Start

```bash
git clone https://github.com/camster91/rotman-av-booking.git
cd rotman-av-booking
npm install
npm start
```

Visit http://localhost:3000 and login with:
- **Username**: `admin`
- **Password**: `rotman2025`

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
EMAIL_TO=cameron.ashley@utoronto.ca
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
- ✅ **Full test suite** (16 tests)

## API

### Submit Booking
```
POST /api/submit
Authorization: Basic auth (admin:rotman2025)
Content-Type: multipart/form-data

Fields:
- event-space: full, one-third, two-thirds, fleck-atrium
- event-name: Event title
- event-date: YYYY-MM-DD
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
npm test          # Run tests (16 passing)
npm run lint      # Lint code
npm run lint:fix  # Auto-fix linting
```

## Docker Deployment

```bash
docker build -t rotman-av-booking .
docker run -p 3000:3000 \
  -e SMTP_PASSWORD="your_password" \
  rotman-av-booking
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | Server port | 3000 |
| SMTP_HOST | SMTP server | smtp.titan.email |
| SMTP_PORT | SMTP port | 587 |
| SMTP_USERNAME | Email address | requests@rotmanav.ca |
| SMTP_PASSWORD | Email password | - |
| EMAIL_TO | Recipient email | - |
| BASE_URL | Public URL | http://localhost:3000 |
| AUTH_USER | Auth username | admin |
| AUTH_PASS | Auth password | rotman2025 |

## License

Proprietary - University of Toronto Rotman School of Management
