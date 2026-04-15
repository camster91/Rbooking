# Rotman AV Booking System

A standalone event booking application for Rotman AV Services.

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env and add your App Password for SMTP

# Start the server
npm start

# Visit http://localhost:3000
```

## Email Setup (Required)

The app sends booking emails via SMTP. For University of Toronto Azure AD:

### Getting an App Password

1. Go to https://account.activedirectory.windowsazure.com#/securityinfo
2. Click "Add method" → Choose "Authenticator app" or "Phone"
3. OR go to "Security info" → "App passwords" → Create new
4. Copy the App Password (looks like: `xxxx xxxx xxxx xxxx`)
5. Paste it in your `.env` file as `SMTP_PASSWORD`

⚠️ **Important**: Use the App Password, NOT your regular password!

## Features

- Multi-step booking form (4 steps)
- Event space selection (Event Hall Full, 1/3, 2/3, Fleck Atrium)
- Time presets (Morning, Afternoon, Evening, Full Day)
- Recording options (None, Basic, Live Web)
- File uploads (images, videos up to 50MB)
- Email notifications with styled HTML templates
- Rate limiting (10 requests per 15 minutes)
- Input validation & XSS protection

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | Server port | 3000 |
| SMTP_HOST | SMTP server | smtp.office365.com |
| SMTP_PORT | SMTP port | 587 |
| SMTP_USERNAME | Your email | - |
| SMTP_PASSWORD | **App Password** | - |
| EMAIL_TO | Recipient email | - |
| BASE_URL | Public URL | http://localhost:3000 |

## Development

```bash
npm run dev      # Start development server
npm test         # Run tests
npm run lint     # Lint code
```

## Docker Deployment

```bash
docker build -t rotman-av-booking .
docker run -p 3000:3000 --env-file .env rotman-av-booking
```

## Python Email Sender (Alternative)

If you prefer Python for email sending:

```bash
# Set credentials
export SMTP_USERNAME="ashleyc2@utoronto.ca"
export SMTP_PASSWORD="xxxx xxxx xxxx xxxx"  # App Password
export EMAIL_TO="ashleyc2@utoronto.ca"

# Send test email
python email_sender.py --to "ashleyc2@utoronto.ca" --subject "Test" --body "Hello"
```

## API

### Submit Booking
```
POST /api/submit
Content-Type: multipart/form-data

Fields:
- event-name: Event title
- event-space: full, one-third, two-thirds, fleck-atrium
- event-date: Date string
- person-of-contact: Contact name
- email-address: Contact email
- registration-time: HH:MM
- event-start-time: HH:MM
- presentation-end-time: HH:MM
- shutdown: HH:MM
- recording-option: none, basic-recording, live-web-recording
- cc-number: Cost Center (optional)
- cfc-number: Cost Fetch Code (optional)
- other-notes: Additional notes (optional)
- media-upload: File attachment (optional)
```

## License

Proprietary - University of Toronto Rotman School of Management