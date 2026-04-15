# Rotman AV Booking System

A standalone event booking application for Rotman AV Services.

## Quick Start

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env

# Start the server
npm start

# Visit http://localhost:3000
```

## Features

- Multi-step booking form
- Event space selection (Event Hall Full, 1/3, 2/3, Fleck Atrium)
- Time presets (Morning, Afternoon, Evening, Full Day)
- Recording options (None, Basic, Live Web)
- File uploads (images, videos up to 50MB)
- Email notifications with styled HTML templates
- Rate limiting (10 requests per 15 minutes)

## Environment Variables

See `.env.example` for all configuration options.

## Development

```bash
npm run dev      # Start development server
npm test         # Run tests
npm run lint     # Lint code
```

## Python Email Sender (Optional)

For sending emails via Outlook Web when SMTP is not available:

```bash
# Install Playwright
pip install -r requirements.txt
python playwright install chromium

# Set credentials
export OUTLOOK_USERNAME="your.email@utoronto.ca"
export OUTLOOK_PASSWORD="your-password"
export EMAIL_TO="recipient@utoronto.ca"

# Send test email
python email_sender.py --to "recipient@utoronto.ca" --subject "Test" --body "Hello World"
```

## Docker Deployment

```bash
docker build -t rotman-av-booking .
docker run -p 3000:3000 --env-file .env rotman-av-booking
```

## License

Proprietary - University of Toronto Rotman School of Management