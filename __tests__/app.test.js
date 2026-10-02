const request = require('supertest');

const {
    app,
    initializeEmailTransporter,
    formatEventSpace,
    formatRecordingOption,
    validateEmail,
    validateTimeOrder,
    sanitizeForEmail,
    parseEventDate,
    generateICS
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

    describe('parseEventDate', () => {
        it('accepts ISO dates (the documented API format)', () => {
            expect(parseEventDate('2026-05-01')).toBe('2026-05-01');
        });

        it('accepts the flatpickr format the UI submits', () => {
            expect(parseEventDate('May 1, 2026')).toBe('2026-05-01');
            expect(parseEventDate('September 21, 2026')).toBe('2026-09-21');
        });

        it('rejects garbage and impossible dates', () => {
            expect(parseEventDate('banana')).toBeNull();
            expect(parseEventDate('2026-02-30')).toBeNull();
            expect(parseEventDate('')).toBeNull();
            expect(parseEventDate(undefined)).toBeNull();
        });
    });

    describe('generateICS', () => {
        const ics = generateICS(
            '2026-05-01', '09:00', '12:00', 'Rotman Test & Launch, Part 1', 'full',
            'basic-recording', 'Test User', 'test@example.com', 'Line one\r\nATTACH;X=evil:evil'
        );
        // Undo RFC 5545 line folding so assertions can match logical lines
        const unfolded = ics.split('\r\n ').join('');

        it('produces RFC 5545 date-times and single-line ORGANIZER/ATTENDEE properties', () => {
            expect(unfolded).toContain('DTSTART:20260501T090000');
            expect(unfolded).toContain('DTEND:20260501T120000');
            expect(unfolded).toContain('ORGANIZER;CN="Rotman AV Services":mailto:requests@rotmanav.ca');
            expect(unfolded).toContain('ATTENDEE;CN="Test User";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:test@example.com');
            expect(ics).not.toContain('BEGIN:ORGANIZER');
        });

        it('escapes TEXT values and cannot be injected via newlines', () => {
            expect(unfolded).toContain('Launch\\, Part 1');    // comma escaped in SUMMARY
            expect(unfolded).toContain('Line one\\nATTACH');   // CRLF became a literal escape
            ics.split('\r\n').forEach((line) => expect(line).not.toMatch(/^ATTACH/i));
        });

        it('folds every line to at most 75 octets', () => {
            ics.split('\r\n').forEach((line) => expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75));
        });
    });
});

describe('API Endpoints', () => {
    const auth = { Authorization: 'Basic ' + Buffer.from(`${process.env.AUTH_USER}:${process.env.AUTH_PASS}`).toString('base64') };

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

    describe('Authentication', () => {
        it('should reject requests without credentials', async () => {
            const res = await request(app).get('/');
            expect(res.status).toBe(401);
        });

        it('should leave /health open for the container healthcheck', async () => {
            const res = await request(app).get('/health');
            expect(res.status).toBe(200);
        });
    });

    describe('Static files', () => {
        it('should not serve app source or config files', async () => {
            for (const file of ['/app.js', '/package.json', '/Dockerfile', '/node_modules/express/package.json']) {
                const res = await request(app).get(file).set(auth);
                expect(res.status).toBe(404);
            }
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

        it('should accept the date format the UI actually submits (flatpickr F j, Y)', async () => {
            const res = await request(app)
                .post('/api/submit')
                .set(auth)
                .type('form')
                .send({
                    'event-space': 'full',
                    'person-of-contact': 'Test User',
                    'email-address': 'test@example.com',
                    'event-date': 'May 1, 2026',
                    'event-name': 'UI Format Event',
                    'registration-time': '08:30',
                    'event-start-time': '09:00',
                    'presentation-end-time': '11:30',
                    'shutdown': '12:00',
                    'recording-option': 'none'
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('should reject an invalid event date', async () => {
            const res = await request(app)
                .post('/api/submit')
                .set(auth)
                .type('form')
                .send({
                    'event-space': 'full',
                    'person-of-contact': 'Test',
                    'email-address': 'test@example.com',
                    'event-date': 'banana',
                    'event-name': 'Test',
                    'registration-time': '08:30',
                    'event-start-time': '09:00',
                    'presentation-end-time': '11:30',
                    'shutdown': '12:00',
                    'recording-option': 'none'
                });

            expect(res.status).toBe(400);
            expect(res.body.message).toContain('date');
        });

        it('should reject time fields that are not HH:MM', async () => {
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
                    'registration-time': '08:30',
                    'event-start-time': '09:00<img src=x onerror=alert(1)>',
                    'presentation-end-time': '11:30',
                    'shutdown': '12:00',
                    'recording-option': 'none'
                });

            expect(res.status).toBe(400);
            expect(res.body.message).toContain('HH:MM');
        });

        it('should reject disallowed upload types with a JSON error', async () => {
            const res = await request(app)
                .post('/api/submit')
                .set(auth)
                .field('email-address', 'test@example.com')
                .attach('media-upload', Buffer.from('<html></html>'), { filename: 'evil.mp4html', contentType: 'video/mp4' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('can be uploaded');
        });
    });
});
