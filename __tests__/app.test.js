const fs = require('fs');
const path = require('path');
const request = require('supertest');

const {
    app,
    store,
    initializeEmailTransporter,
    formatEventSpace,
    formatRecordingOption,
    validateEmail,
    validateTimeOrder,
    sanitizeForEmail,
    parseEventDate,
    generateICS,
    sentMail,
    todayInToronto,
    addDays,
    purgeOldUploads,
    uploadsDir,
    needsBudgetNumber,
    parseTrustProxy
} = require('../app');
const { spacesClash, timesOverlap } = require('../lib/bookings');

beforeAll(async () => {
    await initializeEmailTransporter();
});

const basic = (user, pass) => ({ Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') });
const auth = basic(process.env.AUTH_USER, process.env.AUTH_PASS);
const adminAuth = basic(process.env.ADMIN_USER, process.env.ADMIN_PASS);

// Each test that books gets its own future date so bookings never clash by accident.
let dayOffset = 10;
const nextDate = () => addDays(todayInToronto(), dayOffset++);

function bookingForm(overrides = {}) {
    return {
        'event-space': 'full',
        'person-of-contact': 'Test User',
        'email-address': 'test@example.com',
        'event-date': nextDate(),
        'event-name': 'Test Event',
        'registration-time': '08:30',
        'event-start-time': '09:00',
        'presentation-end-time': '11:30',
        'shutdown': '12:00',
        'recording-option': 'basic-recording',
        ...overrides
    };
}

const submit = (form) => request(app).post('/api/submit').set(auth).type('form').send(form);
const setStatus = (id, status, note) => request(app)
    .post(`/api/admin/bookings/${id}/status`).set(adminAuth).send({ status, note });

const unfold = (ics) => ics.split('\r\n ').join('');

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
            expect(validateEmail('"x\r\nATTACH:http://evil"@example.com')).toBeFalsy();
            expect(validateEmail('"two words"@example.com')).toBeFalsy();
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

        it('should reject a zero-length booking', () => {
            expect(validateTimeOrder('09:00', '09:00', '09:00', '09:00').valid).toBe(false);
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

    describe('needsBudgetNumber', () => {
        it('follows regular AV hours by weekday', () => {
            expect(needsBudgetNumber('2026-10-05', '07:00', '20:00')).toBe(false); // Monday
            expect(needsBudgetNumber('2026-10-05', '06:30', '12:00')).toBe(true);
            expect(needsBudgetNumber('2026-10-09', '09:00', '18:30')).toBe(true);  // Friday
            expect(needsBudgetNumber('2026-10-10', '08:00', '17:00')).toBe(false); // Saturday
            expect(needsBudgetNumber('2026-10-11', '07:30', '12:00')).toBe(true);  // Sunday
        });
    });

    describe('parseTrustProxy', () => {
        it('treats off values as off and passes the rest through', () => {
            for (const off of [undefined, '', 'false', 'FALSE', '0', 'no', 'off']) expect(parseTrustProxy(off)).toBeNull();
            expect(parseTrustProxy('true')).toBe(true);
            expect(parseTrustProxy('2')).toBe(2);
            expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
        });
    });

    describe('double-booking rules', () => {
        it('treats every Event Hall set-up as the same room', () => {
            expect(spacesClash('full', 'one-third')).toBe(true);
            expect(spacesClash('one-third', 'two-thirds')).toBe(true);
            expect(spacesClash('full', 'fleck-atrium')).toBe(false);
        });

        it('only clashes when times overlap (back-to-back is fine)', () => {
            const a = { registrationTime: '09:00', shutdownTime: '12:00' };
            expect(timesOverlap(a, { registrationTime: '11:00', shutdownTime: '13:00' })).toBe(true);
            expect(timesOverlap(a, { registrationTime: '12:00', shutdownTime: '13:00' })).toBe(false);
        });
    });

    describe('generateICS', () => {
        const booking = {
            id: 42, status: 'pending', sequence: 0,
            eventDate: '2026-05-01', registrationTime: '08:30', startTime: '09:00', endTime: '11:30', shutdownTime: '12:00',
            eventName: 'Rotman Test & Launch, Part 1', eventSpace: 'full', recordingOption: 'basic-recording',
            contactName: 'Test User', contactEmail: 'test@example.com', notes: 'Line one\r\nATTACH;X=evil:evil'
        };
        const ics = generateICS(booking);
        const unfolded = unfold(ics);

        it('produces RFC 5545 date-times and single-line ORGANIZER/ATTENDEE properties', () => {
            expect(unfolded).toContain('DTSTART;TZID=America/Toronto:20260501T083000');
            expect(unfolded).toContain('DTEND;TZID=America/Toronto:20260501T120000');
            expect(unfolded).toContain('BEGIN:VTIMEZONE');
            expect(unfolded).toContain('ORGANIZER;CN="Rotman AV Services":mailto:requests@rotmanav.ca');
            expect(unfolded).toContain('ATTENDEE;CN="Test User";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:test@example.com');
            expect(ics).not.toContain('BEGIN:ORGANIZER');
        });

        it('uses a stable UID per booking and marks pending bookings tentative', () => {
            expect(unfolded).toContain('UID:booking-42@rotmanav.ca');
            expect(unfolded).toContain('STATUS:TENTATIVE');
            expect(unfold(generateICS({ ...booking, status: 'approved' }))).toContain('STATUS:CONFIRMED');
            const cancel = unfold(generateICS({ ...booking, status: 'cancelled', sequence: 2 }, 'CANCEL'));
            expect(cancel).toContain('METHOD:CANCEL');
            expect(cancel).toContain('STATUS:CANCELLED');
            expect(cancel).toContain('SEQUENCE:2');
        });

        it('escapes TEXT values and cannot be injected via newlines', () => {
            expect(unfolded).toContain('Launch\\, Part 1');    // comma escaped in SUMMARY
            expect(unfolded).toContain('Line one\\nATTACH');   // CRLF became a literal escape
            ics.split('\r\n').forEach((line) => expect(line).not.toMatch(/^ATTACH/i));
        });

        it('never lets an email address add lines to the invite', () => {
            const evil = unfold(generateICS({ ...booking, contactEmail: '"x\r\nATTACH:http://evil"@example.com' }));
            evil.split('\r\n').forEach((line) => expect(line).not.toMatch(/^ATTACH/));
            expect(evil).toContain('mailto:xATTACHhttp//evil@example.com');
        });

        it('folds every line to at most 75 octets', () => {
            ics.split('\r\n').forEach((line) => expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75));
        });
    });
});

describe('Pages and login', () => {
    it('should serve the booking form', async () => {
        const res = await request(app).get('/').set(auth);
        expect(res.status).toBe(200);
        expect(res.type).toMatch(/html/);
    });

    it('should reject requests without credentials', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(401);
    });

    it('should leave /health open for the container healthcheck', async () => {
        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.email).toBeDefined();
    });

    it('should not serve app source or config files', async () => {
        for (const file of ['/app.js', '/package.json', '/Dockerfile', '/node_modules/express/package.json', '/data/bookings.db']) {
            const res = await request(app).get(file).set(adminAuth);
            expect(res.status).toBe(404);
        }
    });

    it('lets the admin login use the booking form too', async () => {
        const res = await request(app).get('/').set(adminAuth);
        expect(res.status).toBe(200);
    });

    it('keeps the admin page and API away from the shared form login', async () => {
        for (const url of ['/admin', '/api/admin/bookings']) {
            const asUser = await request(app).get(url).set(auth);
            expect(asUser.status).toBe(401);
            expect(asUser.headers['www-authenticate']).toContain('Rotman AV Admin');
            const asAdmin = await request(app).get(url).set(adminAuth);
            expect(asAdmin.status).toBe(200);
        }
    });
});

describe('POST /api/submit', () => {
    beforeEach(() => { sentMail.length = 0; });

    it('saves a valid booking as pending and emails staff and the requester', async () => {
        const form = bookingForm();
        const res = await submit(form);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.confirmationSent).toBe(true);

        const saved = store.get(res.body.id);
        expect(saved.status).toBe('pending');
        expect(saved.eventDate).toBe(form['event-date']);

        expect(sentMail).toHaveLength(2);
        const staff = sentMail.find(m => m.to === 'requests@rotmanav.ca');
        const requester = sentMail.find(m => m.to === 'test@example.com');
        expect(staff.replyTo).toBe('test@example.com');
        expect(unfold(staff.alternatives[0].content)).toContain('STATUS:TENTATIVE');
        expect(requester.subject).toContain(`#${res.body.id}`);
        expect(requester.html).toContain('not confirmed yet');
        expect(requester.alternatives).toBeUndefined();
    });

    it('accepts the date format the form sends', async () => {
        const iso = nextDate();
        const pretty = new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
        const res = await submit(bookingForm({ 'event-date': pretty }));
        expect(res.status).toBe(200);
        expect(store.get(res.body.id).eventDate).toBe(iso);
    });

    it('escapes user text in emails', async () => {
        const res = await submit(bookingForm({ 'event-name': '<img src=x onerror=alert(1)>', 'other-notes': '<b>hi</b>' }));
        expect(res.status).toBe(200);
        for (const m of sentMail) {
            expect(m.html).not.toContain('<img src=x');
            expect(m.html).not.toContain('<b>hi</b>');
        }
    });

    it('should reject invalid email', async () => {
        const res = await submit(bookingForm({ 'email-address': 'invalid-email' }));
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('requires a budget number outside regular AV hours', async () => {
        // A future Sunday, booked from 6am
        let sunday = nextDate();
        while (new Date(sunday + 'T12:00:00Z').getUTCDay() !== 0) sunday = nextDate();
        const early = { 'event-date': sunday, 'registration-time': '06:00', 'event-start-time': '06:30' };
        const missing = await submit(bookingForm(early));
        expect(missing.status).toBe(400);
        expect(missing.body.message).toContain('CC#');
        expect((await submit(bookingForm({ ...early, 'cfc-number': '98765' }))).status).toBe(200);
    });

    it('should reject dates in the past', async () => {
        const res = await submit(bookingForm({ 'event-date': addDays(todayInToronto(), -1) }));
        expect(res.status).toBe(400);
        expect(res.body.message).toContain('past');
    });

    it('should reject an invalid date', async () => {
        const res = await submit(bookingForm({ 'event-date': 'not-a-date' }));
        expect(res.status).toBe(400);
        expect(res.body.message).toContain('date');
    });

    it('should reject unknown spaces and recording options', async () => {
        const space = await submit(bookingForm({ 'event-space': '<b>roof</b>' }));
        expect(space.status).toBe(400);
        const recording = await submit(bookingForm({ 'recording-option': 'drone' }));
        expect(recording.status).toBe(400);
    });

    it('should reject time fields that are not HH:MM', async () => {
        const res = await submit(bookingForm({ 'event-start-time': '09:00<img src=x onerror=alert(1)>' }));
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

    it('deletes the uploaded file when the booking is rejected', async () => {
        const before = new Set(fs.readdirSync(uploadsDir));
        const res = await request(app)
            .post('/api/submit')
            .set(auth)
            .field('email-address', 'bad')
            .attach('media-upload', Buffer.from('fake'), { filename: 'photo.png', contentType: 'image/png' });
        expect(res.status).toBe(400);
        await new Promise(r => setTimeout(r, 50));
        const added = fs.readdirSync(uploadsDir).filter(f => !before.has(f));
        expect(added).toEqual([]);
    });
});

describe('Double booking', () => {
    beforeEach(() => { sentMail.length = 0; });

    it('refuses a request that overlaps an approved booking in the same room', async () => {
        const date = nextDate();
        const first = await submit(bookingForm({ 'event-date': date }));
        expect((await setStatus(first.body.id, 'approved')).status).toBe(200);

        const clash = await submit(bookingForm({ 'event-date': date, 'event-space': 'one-third', 'registration-time': '11:00', 'event-start-time': '11:00', 'presentation-end-time': '13:00', 'shutdown': '13:30' }));
        expect(clash.status).toBe(409);
        expect(clash.body.message).toContain('already booked');

        // A different room, or right after shutdown, is fine
        expect((await submit(bookingForm({ 'event-date': date, 'event-space': 'fleck-atrium' }))).status).toBe(200);
        expect((await submit(bookingForm({ 'event-date': date, 'registration-time': '12:00', 'event-start-time': '12:30', 'presentation-end-time': '14:00', 'shutdown': '14:30' }))).status).toBe(200);
    });

    it('accepts a request that overlaps a pending one but warns staff', async () => {
        const date = nextDate();
        const first = await submit(bookingForm({ 'event-date': date }));
        sentMail.length = 0;
        const second = await submit(bookingForm({ 'event-date': date }));
        expect(second.status).toBe(200);
        const staff = sentMail.find(m => m.to === 'requests@rotmanav.ca');
        expect(staff.html).toContain('Possible double booking');
        expect(staff.html).toContain(`#${first.body.id}`);

        // Approving one blocks approving the other
        expect((await setStatus(first.body.id, 'approved')).status).toBe(200);
        const blocked = await setStatus(second.body.id, 'approved');
        expect(blocked.status).toBe(409);
        expect(blocked.body.message).toContain(`#${first.body.id}`);
    });

    it('shows taken times without personal details', async () => {
        const date = nextDate();
        await submit(bookingForm({ 'event-date': date, 'event-name': 'Secret Board Meeting' }));
        const res = await request(app).get(`/api/availability?date=${date}&space=two-thirds`).set(auth);
        expect(res.status).toBe(200);
        expect(res.body.bookings).toEqual([
            { space: 'full', spaceName: 'Event Hall Full', from: '08:30', to: '12:00', status: 'pending' }
        ]);
        expect(JSON.stringify(res.body)).not.toContain('Secret');

        const atrium = await request(app).get(`/api/availability?date=${date}&space=fleck-atrium`).set(auth);
        expect(atrium.body.bookings).toEqual([]);
    });
});

describe('Admin', () => {
    beforeEach(() => { sentMail.length = 0; });

    it('lists upcoming bookings with conflicts', async () => {
        const date = nextDate();
        const a = await submit(bookingForm({ 'event-date': date }));
        const b = await submit(bookingForm({ 'event-date': date }));
        const res = await request(app).get('/api/admin/bookings?scope=upcoming').set(adminAuth);
        expect(res.status).toBe(200);
        const listed = res.body.bookings.find(x => x.id === a.body.id);
        expect(listed.spaceName).toBe('Event Hall Full');
        expect(listed.conflicts.map(c => c.id)).toEqual([b.body.id]);
    });

    it('approving emails the requester a confirmed invite and updates staff', async () => {
        const created = await submit(bookingForm());
        sentMail.length = 0;
        const res = await setStatus(created.body.id, 'approved', 'See you there');
        expect(res.status).toBe(200);
        expect(res.body.booking.status).toBe('approved');

        const requester = sentMail.find(m => m.to === 'test@example.com');
        expect(requester.subject).toContain('approved');
        expect(requester.html).toContain('See you there');
        const ics = unfold(requester.alternatives[0].content);
        expect(ics).toContain('STATUS:CONFIRMED');
        expect(ics).toContain('SEQUENCE:1');
        expect(sentMail.find(m => m.to === 'requests@rotmanav.ca')).toBeDefined();
    });

    it('declining emails the requester without an invite and cancels the staff entry', async () => {
        const created = await submit(bookingForm());
        sentMail.length = 0;
        const res = await setStatus(created.body.id, 'declined', 'Room closed');
        expect(res.status).toBe(200);
        const requester = sentMail.find(m => m.to === 'test@example.com');
        expect(requester.alternatives).toBeUndefined();
        const staff = sentMail.find(m => m.to === 'requests@rotmanav.ca');
        expect(unfold(staff.alternatives[0].content)).toContain('METHOD:CANCEL');
    });

    it('cancelling an approved booking sends the requester a calendar cancel', async () => {
        const created = await submit(bookingForm());
        await setStatus(created.body.id, 'approved');
        sentMail.length = 0;
        const res = await setStatus(created.body.id, 'cancelled');
        expect(res.status).toBe(200);
        const requester = sentMail.find(m => m.to === 'test@example.com');
        expect(unfold(requester.alternatives[0].content)).toContain('METHOD:CANCEL');
    });

    it('refuses invalid changes', async () => {
        const created = await submit(bookingForm());
        await setStatus(created.body.id, 'declined');
        expect((await setStatus(created.body.id, 'approved')).status).toBe(409);
        expect((await setStatus(999999, 'approved')).status).toBe(404);
        expect((await setStatus(created.body.id, 'banana')).status).toBe(400);
    });

    it('only accepts JSON status changes (blocks cross-site forms)', async () => {
        const created = await submit(bookingForm());
        const res = await request(app)
            .post(`/api/admin/bookings/${created.body.id}/status`)
            .set(adminAuth).type('form').send({ status: 'approved' });
        expect(res.status).toBe(415);
        expect(store.get(created.body.id).status).toBe('pending');
    });

    it('only lets staff open uploaded files', async () => {
        const name = 'test-upload-access.png';
        fs.writeFileSync(path.join(uploadsDir, name), 'x');
        try {
            expect((await request(app).get(`/uploads/${name}`).set(auth)).status).toBe(401);
            expect((await request(app).get(`/uploads/${name}`).set(adminAuth)).status).toBe(200);
        } finally {
            fs.rmSync(path.join(uploadsDir, name), { force: true });
        }
    });
});

describe('Upload cleanup', () => {
    it('deletes files for old events and stray files, keeps current ones', () => {
        const write = (name) => { fs.writeFileSync(path.join(uploadsDir, name), 'x'); return name; };
        const base = {
            eventName: 'Old', eventSpace: 'fleck-atrium', registrationTime: '09:00', startTime: '09:00',
            endTime: '10:00', shutdownTime: '10:00', contactName: 'A', contactEmail: 'a@example.com', recordingOption: 'none'
        };
        const oldFile = write('cleanup-old.png');
        const keepFile = write('cleanup-keep.png');
        const strayFile = write('cleanup-stray.png');
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        fs.utimesSync(path.join(uploadsDir, strayFile), twoDaysAgo, twoDaysAgo);

        const old = store.create({ ...base, eventDate: addDays(todayInToronto(), -200), uploadFile: oldFile }).booking;
        const keep = store.create({ ...base, eventDate: nextDate(), uploadFile: keepFile }).booking;

        try {
            purgeOldUploads();
            expect(fs.existsSync(path.join(uploadsDir, oldFile))).toBe(false);
            expect(fs.existsSync(path.join(uploadsDir, strayFile))).toBe(false);
            expect(fs.existsSync(path.join(uploadsDir, keepFile))).toBe(true);
            expect(store.get(old.id).uploadFile).toBeNull();
            expect(store.get(keep.id).uploadFile).toBe(keepFile);
        } finally {
            for (const f of [oldFile, keepFile, strayFile]) fs.rmSync(path.join(uploadsDir, f), { force: true });
        }
    });
});

describe('Cross-site protection', () => {
    it('refuses booking posts from other websites', async () => {
        const fromEvil = await submit(bookingForm()).set('Origin', 'https://evil.example');
        expect(fromEvil.status).toBe(403);
        const crossSite = await submit(bookingForm()).set('Sec-Fetch-Site', 'cross-site');
        expect(crossSite.status).toBe(403);
    });

    it('allows posts from the app itself', async () => {
        const res = await submit(bookingForm()).set('Host', 'booking.test').set('Origin', 'http://booking.test');
        expect(res.status).toBe(200);
        // Behind a proxy the Host can differ; the browser's same-origin flag is enough
        const proxied = await submit(bookingForm()).set('Host', 'internal:3000').set('Origin', 'https://booking.example').set('Sec-Fetch-Site', 'same-origin');
        expect(proxied.status).toBe(200);
    });

    it('protects admin status changes too', async () => {
        const created = await submit(bookingForm());
        const res = await setStatus(created.body.id, 'approved').set('Origin', 'https://evil.example');
        expect(res.status).toBe(403);
        expect(store.get(created.body.id).status).toBe('pending');
    });
});

describe('Admin list', () => {
    it('shows the newest bookings first in All, and can fetch any one booking', async () => {
        const older = await submit(bookingForm());
        const newer = await submit(bookingForm());
        const all = await request(app).get('/api/admin/bookings?scope=all').set(adminAuth);
        const ids = all.body.bookings.map(b => b.id);
        expect(ids.indexOf(newer.body.id)).toBeLessThan(ids.indexOf(older.body.id));
        expect(typeof all.body.pendingCount).toBe('number');

        const one = await request(app).get(`/api/admin/bookings/${older.body.id}`).set(adminAuth);
        expect(one.status).toBe(200);
        expect(one.body.booking.id).toBe(older.body.id);
        expect((await request(app).get('/api/admin/bookings/999999').set(adminAuth)).status).toBe(404);
        expect((await request(app).get(`/api/admin/bookings/${older.body.id}`).set(auth)).status).toBe(401);
    });
});

describe('Upload cleanup robustness', () => {
    it('does not crash on folders or files that vanish', () => {
        const dir = path.join(uploadsDir, 'a-folder');
        fs.mkdirSync(dir, { recursive: true });
        const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
        fs.utimesSync(dir, old, old);
        const gone = store.create({
            eventName: 'Gone', eventSpace: 'fleck-atrium', registrationTime: '09:00', startTime: '09:00',
            endTime: '10:00', shutdownTime: '10:00', contactName: 'A', contactEmail: 'a@example.com',
            recordingOption: 'none', eventDate: addDays(todayInToronto(), -300), uploadFile: 'never-existed.png'
        }).booking;
        try {
            expect(() => purgeOldUploads()).not.toThrow();
            expect(fs.existsSync(dir)).toBe(true);
            expect(store.get(gone.id).uploadFile).toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

// Last: these wrong passwords count against this test run's IP.
describe('Failed-login limit', () => {
    it('blocks repeated wrong passwords but never a correct login', async () => {
        const wrong = basic('nobody', 'wrong');
        let last;
        for (let i = 0; i < 31; i++) last = await request(app).get('/').set(wrong);
        expect(last.status).toBe(429);
        expect((await request(app).get('/').set(auth)).status).toBe(200);
        // A first visit with no credentials still gets the login prompt, not a block
        expect((await request(app).get('/')).status).toBe(401);
    });
});
