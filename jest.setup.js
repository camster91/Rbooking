// Clear SMTP env vars before tests so email uses console logging fallback
delete process.env.SMTP_HOST;
delete process.env.SMTP_PASSWORD;
delete process.env.SMTP_USERNAME;
delete process.env.SMTP_PORT;
delete process.env.SMTP_SECURE;