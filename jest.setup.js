// Clear SMTP env vars before tests so email uses the in-memory test transport
delete process.env.SMTP_HOST;
delete process.env.SMTP_PASSWORD;
delete process.env.SMTP_USERNAME;
delete process.env.SMTP_PORT;
delete process.env.SMTP_SECURE;
delete process.env.EMAIL_TO;
delete process.env.BASE_URL;

// Dedicated test credentials so the suite does not depend on the shipped defaults
process.env.AUTH_USER = 'test-user';
process.env.AUTH_PASS = 'test-pass';
process.env.ADMIN_USER = 'test-admin';
process.env.ADMIN_PASS = 'test-admin-pass';

// Fresh in-memory database for every test file; no rate limit on submissions
process.env.DB_FILE = ':memory:';
process.env.SUBMIT_RATE_LIMIT = '1000';

// Uploads go to a throwaway folder so tests (including the cleanup test) never
// touch real files
process.env.UPLOADS_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'rotman-av-test-'));
