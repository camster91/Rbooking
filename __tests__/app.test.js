const request = require('supertest');

// Mock SMTP password for testing
process.env.SMTP_PASSWORD = 'test-password';

const {
    app,
    initializeEmailTransporter,
    formatEventSpace,
    formatRecordingOption,
    validateEmail,
    validateTimeOrder,
    sanitizeForEmail
} = require('../app');

beforeAll(async () => {
    await initializeEmailTransporter();
});

describe('Helper Functions', () => {
    describe('formatEventSpace', () => {
        it('should format event spaces correctly', () => {
            expect(formatEventSpace('full')).toBe('Event Hall Full');
            expect(formatEventSpace('one-third')).toBe('Event Hall 1/3');
            expect(formatEventSpace('two-thirds')).toBe('Event Hall 2/3');
            expect(formatEventSpace('fleck-atrium')).toBe('Fleck Atrium');
        });

        it('should return unknown values as-is', () => {
            expect(formatEventSpace('unknown')).toBe('unknown');
        });
    });

    describe('formatRecordingOption', () => {
        it('should format recording options correctly', () => {
            expect(formatRecordingOption('none')).toBe('None - Technician on site only');
            expect(formatRecordingOption('basic-recording')).toBe('Basic Recording - Fixed wide shot or Zoom');
            expect(formatRecordingOption('live-web-recording')).toBe('Live Web Recording - Full setup with additional technician');
        });
    });

    describe('validateEmail', () => {
        it('should validate correct emails', () => {
            expect(validateEmail('user@example.com')).toBe(true);
            expect(validateEmail('test@utoronto.ca')).toBe(true);
        });

        it('should reject invalid emails', () => {
            expect(validateEmail('invalid')).toBeFalsy();
            expect(validateEmail('')).toBeFalsy();
            expect(validateEmail(null)).toBeFalsy();
        });
    });

    describe('validateTimeOrder', () => {
        it('should validate correct time order', () => {
            const result = validateTimeOrder('08:30', '09:00', '11:30', '12:00');
            expect(result.valid).toBe(true);
        });

        it('should reject invalid time order', () => {
            const result = validateTimeOrder('11:00', '09:00', '11:30', '12:00');
            expect(result.valid).toBe(false);
            expect(result.message).toContain('Registration');
        });

        it('should reject if end is after shutdown', () => {
            const result = validateTimeOrder('08:30', '09:00', '15:00', '14:00');
            expect(result.valid).toBe(false);
            expect(result.message).toContain('Presentation');
        });
    });

    describe('sanitizeForEmail', () => {
        it('should escape HTML characters', () => {
            expect(sanitizeForEmail('<script>')).toBe('&lt;script&gt;');
            expect(sanitizeForEmail('Tom & Jerry')).toBe('Tom &amp; Jerry');
        });

        it('should handle null/undefined', () => {
            expect(sanitizeForEmail(null)).toBe('');
            expect(sanitizeForEmail(undefined)).toBe('');
        });
    });
});

describe('API Endpoints', () => {
    const auth = { Authorization: 'Basic ' + Buffer.from('admin:rotman2025').toString('base64') };

    describe('GET /', () => {
        it('should serve the booking form', async () => {
            const res = await request(app).get('/').set(auth);
            expect(res.status).toBe(200);
            expect(res.type).toMatch(/html/);
        });
    });

    describe('GET /health', () => {
        it('should return health status', async () => {
            const res = await request(app).get('/health').set(auth);
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('ok');
            expect(res.body.email).toBeDefined();
        });
    });

    describe('POST /api/submit', () => {
        it('should accept valid booking request', async () => {
            const res = await request(app)
                .post('/api/submit')
                .set(auth)
                .type('form')
                .send({
                    'event-space': 'full',
                    'person-of-contact': 'Test User',
                    'email-address': 'test@example.com',
                    'event-date': '2026-05-01',
                    'event-name': 'Test Event',
                    'registration-time': '08:30',
                    'event-start-time': '09:00',
                    'presentation-end-time': '11:30',
                    'shutdown': '12:00',
                    'recording-option': 'basic-recording'
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('should reject invalid email', async () => {
            const res = await request(app)
                .post('/api/submit')
                .set(auth)
                .type('form')
                .send({
                    'event-space': 'full',
                    'person-of-contact': 'Test',
                    'email-address': 'invalid-email',
                    'event-date': '2026-05-01',
                    'event-name': 'Test',
                    'registration-time': '08:30',
                    'event-start-time': '09:00',
                    'presentation-end-time': '11:30',
                    'shutdown': '12:00',
                    'recording-option': 'none'
                });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('email');
        });

        it('should reject invalid time order', async () => {
            const res = await request(app)
                .post('/api/submit')
                .set(auth)
                .type('form')
                .send({
                    'event-space': 'full',
                    'person-of-contact': 'Test',
                    'email-address': 'test@example.com',
                    'event-date': '2026-05-01',
                    'event-name': 'Test',
                    'registration-time': '11:00',  // After start time
                    'event-start-time': '09:00',
                    'presentation-end-time': '11:30',
                    'shutdown': '12:00',
                    'recording-option': 'none'
                });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('should sanitize XSS attempts', async () => {
            const res = await request(app)
                .post('/api/submit')
                .set(auth)
                .type('form')
                .send({
                    'event-space': 'full',
                    'person-of-contact': '<script>alert("xss")</script>',
                    'email-address': 'test@example.com',
                    'event-date': '2026-05-01',
                    'event-name': '<img src=x onerror=alert(1)>',
                    'registration-time': '08:30',
                    'event-start-time': '09:00',
                    'presentation-end-time': '11:30',
                    'shutdown': '12:00',
                    'recording-option': 'none'
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });
});
