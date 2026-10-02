import { describe, it, expect, beforeEach } from 'vitest';
import { sentMail } from '../src/mailer.js';
import { bookingStore } from '../src/bookings.js';
import { purgeOldUploads } from '../src/index.js';
import {
    env, call, submit, setStatus, upload, bookingForm, nextDate, todayInToronto, addDays, unfold,
    USER, ADMIN, WRONG
} from './helpers.js';

const store = () => bookingStore(env.DB);
const staffMail = () => sentMail.find(m => m.to === 'requests@rotmanav.ca');
const requesterMail = () => sentMail.find(m => m.to === 'test@example.com');

beforeEach(() => { sentMail.length = 0; });

describe('pages and login', () => {
    it('serves the booking form to the form login', async () => {
        const res = await call('/');
        expect(res.status).toBe(200);
        expect(res.data).toContain('Book an Event');
    });

    it('asks for a login, with a friendly page if cancelled', async () => {
        const res = await call('/', { auth: null });
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toContain('Rotman AV');
        expect(res.data).toContain('Sign in needed');
    });

    it('leaves /health open', async () => {
        const res = await call('/health', { auth: null });
        expect(res.status).toBe(200);
        expect(res.data.configured).toBe(true);
    });

    it('refuses everything when the passwords are not set', async () => {
        const res = await call('/', { envOverride: { AUTH_PASS: undefined } });
        expect(res.status).toBe(503);
        expect((await call('/health', { auth: null, envOverride: { ADMIN_PASS: '' } })).data.configured).toBe(false);
    });

    it('keeps the admin page and API away from the form login', async () => {
        for (const url of ['/admin', '/api/admin/bookings']) {
            const asUser = await call(url);
            expect(asUser.status).toBe(401);
            expect(asUser.headers.get('www-authenticate')).toContain('Rotman AV Admin');
            expect((await call(url, { auth: ADMIN })).status).toBe(200);
        }
    });

    it('does not serve page files directly by name', async () => {
        for (const url of ['/admin.html', '/index.html', '/src/index.js', '/wrangler.jsonc']) {
            expect((await call(url)).status).toBe(404);
        }
    });

    it('lets the admin login use the booking form too', async () => {
        expect((await call('/', { auth: ADMIN })).status).toBe(200);
    });
});

describe('POST /api/submit', () => {
    it('saves a valid booking as pending and emails staff and the requester', async () => {
        const form = bookingForm();
        const res = await submit(form);
        expect(res.status).toBe(200);
        expect(res.data.success).toBe(true);
        expect(res.data.confirmationSent).toBe(true);

        const saved = await store().get(res.data.id);
        expect(saved.status).toBe('pending');
        expect(saved.eventDate).toBe(form['event-date']);

        expect(sentMail).toHaveLength(2);
        expect(staffMail().replyTo).toBe('test@example.com');
        expect(unfold(staffMail().alternatives[0].content)).toContain('STATUS:TENTATIVE');
        expect(requesterMail().subject).toContain(`#${res.data.id}`);
        expect(requesterMail().html).toContain('not confirmed yet');
        expect(requesterMail().alternatives).toBeUndefined();
    });

    it('accepts multipart form data and the date format the form sends', async () => {
        const iso = nextDate();
        const pretty = new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
        const fd = new FormData();
        for (const [k, v] of Object.entries(bookingForm({ 'event-date': pretty }))) fd.set(k, v);
        const res = await call('/api/submit', { method: 'POST', body: fd });
        expect(res.status).toBe(200);
        expect((await store().get(res.data.id)).eventDate).toBe(iso);
    });

    it('escapes user text in emails', async () => {
        const res = await submit(bookingForm({ 'event-name': '<img src=x onerror=alert(1)>', 'other-notes': '<b>hi</b>' }));
        expect(res.status).toBe(200);
        for (const m of sentMail) {
            expect(m.html).not.toContain('<img src=x');
            expect(m.html).not.toContain('<b>hi</b>');
        }
    });

    it.each([
        ['an invalid email', { 'email-address': 'invalid-email' }, 'email'],
        ['a quoted email', { 'email-address': '"a\r\nb"@example.com' }, 'email'],
        ['a past date', { 'event-date': addDays(todayInToronto(), -1) }, 'past'],
        ['an invalid date', { 'event-date': 'not-a-date' }, 'date'],
        ['an unknown space', { 'event-space': '<b>roof</b>' }, 'space'],
        ['an unknown recording option', { 'recording-option': 'drone' }, 'recording'],
        ['times that are not HH:MM', { 'event-start-time': '09:00<img>' }, 'HH:MM']
    ])('rejects %s', async (_, overrides, words) => {
        const res = await submit(bookingForm(overrides));
        expect(res.status).toBe(400);
        expect(res.data.message).toContain(words);
        expect(sentMail).toHaveLength(0);
    });

    it('requires a budget number outside regular AV hours', async () => {
        let sunday = nextDate();
        while (new Date(sunday + 'T12:00:00Z').getUTCDay() !== 0) sunday = nextDate();
        const early = { 'event-date': sunday, 'registration-time': '06:00', 'event-start-time': '06:30' };
        const missing = await submit(bookingForm(early));
        expect(missing.status).toBe(400);
        expect(missing.data.message).toContain('CC#');
        expect((await submit(bookingForm({ ...early, 'cfc-number': '98765' }))).status).toBe(200);
    });
});

describe('uploads', () => {
    it('stores a file and attaches it to a booking that only staff can open', async () => {
        const up = await upload('stage plan.png', 'image/png');
        expect(up.status).toBe(200);
        const key = up.data.uploadKey;
        expect(key).toMatch(/^[a-f0-9]{24}-stage_plan\.png$/);

        const res = await submit(bookingForm({ 'upload-key': key }));
        expect(res.status).toBe(200);
        expect((await store().get(res.data.id)).uploadKey).toBe(key);
        expect(staffMail().html).toContain(`/uploads/${key}`);

        expect((await call(`/uploads/${key}`)).status).toBe(401);
        const asAdmin = await call(`/uploads/${key}`, { auth: ADMIN });
        expect(asAdmin.status).toBe(200);
        expect(asAdmin.headers.get('content-type')).toBe('image/png');
        expect(asAdmin.headers.get('x-content-type-options')).toBe('nosniff');

        // The same file can't be attached to a second booking
        const again = await submit(bookingForm({ 'upload-key': key }));
        expect(again.status).toBe(400);
    });

    it('rejects disallowed types, oversize files and unknown keys', async () => {
        const bad = await upload('evil.mp4html', 'video/mp4');
        expect(bad.status).toBe(400);
        expect(bad.data.message).toContain('can be uploaded');

        const big = await call('/api/uploads', {
            method: 'PUT', body: new Uint8Array(10),
            headers: { 'content-type': 'video/mp4', 'x-file-name': 'big.mp4', 'content-length': String(60 * 1024 * 1024) }
        });
        expect(big.status).toBe(413);

        const missing = await submit(bookingForm({ 'upload-key': 'a'.repeat(24) + '-nope.png' }));
        expect(missing.status).toBe(400);
        expect(missing.data.message).toContain('attach it again');
    });
});

describe('double booking', () => {
    it('refuses a request that overlaps an approved booking in the same room', async () => {
        const date = nextDate();
        const first = await submit(bookingForm({ 'event-date': date }));
        expect((await setStatus(first.data.id, 'approved')).status).toBe(200);

        const clash = await submit(bookingForm({ 'event-date': date, 'event-space': 'one-third', 'registration-time': '11:00', 'event-start-time': '11:00', 'presentation-end-time': '13:00', 'shutdown': '13:30' }));
        expect(clash.status).toBe(409);
        expect(clash.data.message).toContain('already booked');

        // A different room, or right after shutdown, is fine
        expect((await submit(bookingForm({ 'event-date': date, 'event-space': 'fleck-atrium' }))).status).toBe(200);
        expect((await submit(bookingForm({ 'event-date': date, 'registration-time': '12:00', 'event-start-time': '12:30', 'presentation-end-time': '14:00', 'shutdown': '14:30' }))).status).toBe(200);
    });

    it('accepts a request that overlaps a pending one but warns staff, and blocks approving both', async () => {
        const date = nextDate();
        const first = await submit(bookingForm({ 'event-date': date }));
        sentMail.length = 0;
        const second = await submit(bookingForm({ 'event-date': date }));
        expect(second.status).toBe(200);
        expect(staffMail().html).toContain('Possible double booking');
        expect(staffMail().html).toContain(`#${first.data.id}`);

        expect((await setStatus(first.data.id, 'approved')).status).toBe(200);
        const blocked = await setStatus(second.data.id, 'approved');
        expect(blocked.status).toBe(409);
        expect(blocked.data.message).toContain(`#${first.data.id}`);
    });

    it('shows taken times without personal details', async () => {
        const date = nextDate();
        await submit(bookingForm({ 'event-date': date, 'event-name': 'Secret Board Meeting' }));
        const res = await call(`/api/availability?date=${date}&space=two-thirds`);
        expect(res.data.bookings).toEqual([
            { space: 'full', spaceName: 'Event Hall Full', from: '08:30', to: '12:00', status: 'pending' }
        ]);
        expect(JSON.stringify(res.data)).not.toContain('Secret');
        expect((await call(`/api/availability?date=${date}&space=fleck-atrium`)).data.bookings).toEqual([]);
    });
});

describe('admin', () => {
    it('lists bookings with conflicts and a pending count', async () => {
        const date = nextDate();
        const a = await submit(bookingForm({ 'event-date': date }));
        const b = await submit(bookingForm({ 'event-date': date }));
        const res = await call('/api/admin/bookings?scope=upcoming', { auth: ADMIN });
        const listed = res.data.bookings.find(x => x.id === a.data.id);
        expect(listed.spaceName).toBe('Event Hall Full');
        expect(listed.conflicts.map(c => c.id)).toEqual([b.data.id]);
        expect(res.data.pendingCount).toBeGreaterThanOrEqual(2);
    });

    it('shows newest first in All and can fetch one booking', async () => {
        const older = await submit(bookingForm());
        const newer = await submit(bookingForm());
        const all = await call('/api/admin/bookings?scope=all', { auth: ADMIN });
        const ids = all.data.bookings.map(b => b.id);
        expect(ids.indexOf(newer.data.id)).toBeLessThan(ids.indexOf(older.data.id));
        const one = await call(`/api/admin/bookings/${older.data.id}`, { auth: ADMIN });
        expect(one.data.booking.id).toBe(older.data.id);
        expect((await call('/api/admin/bookings/999999', { auth: ADMIN })).status).toBe(404);
    });

    it('approving emails a confirmed invite and updates staff', async () => {
        const created = await submit(bookingForm());
        sentMail.length = 0;
        const res = await setStatus(created.data.id, 'approved', 'See you there');
        expect(res.status).toBe(200);
        expect(res.data.booking.status).toBe('approved');
        expect(requesterMail().html).toContain('See you there');
        const ics = unfold(requesterMail().alternatives[0].content);
        expect(ics).toContain('STATUS:CONFIRMED');
        expect(ics).toContain('SEQUENCE:1');
        expect(staffMail()).toBeDefined();
    });

    it('declining sends no invite and cancels the staff calendar entry', async () => {
        const created = await submit(bookingForm());
        sentMail.length = 0;
        expect((await setStatus(created.data.id, 'declined', 'Room closed')).status).toBe(200);
        expect(requesterMail().alternatives).toBeUndefined();
        expect(unfold(staffMail().alternatives[0].content)).toContain('METHOD:CANCEL');
    });

    it('cancelling an approved booking sends the requester a calendar cancel', async () => {
        const created = await submit(bookingForm());
        await setStatus(created.data.id, 'approved');
        sentMail.length = 0;
        expect((await setStatus(created.data.id, 'cancelled')).status).toBe(200);
        expect(unfold(requesterMail().alternatives[0].content)).toContain('METHOD:CANCEL');
    });

    it('refuses invalid changes', async () => {
        const created = await submit(bookingForm());
        await setStatus(created.data.id, 'declined');
        expect((await setStatus(created.data.id, 'approved')).status).toBe(409);
        expect((await setStatus(999999, 'approved')).status).toBe(404);
        expect((await setStatus(created.data.id, 'banana')).status).toBe(400);
    });

    it('only accepts JSON status changes', async () => {
        const created = await submit(bookingForm());
        const res = await call(`/api/admin/bookings/${created.data.id}/status`, {
            method: 'POST', auth: ADMIN,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'status=approved'
        });
        expect(res.status).toBe(415);
        expect((await store().get(created.data.id)).status).toBe('pending');
    });
});

describe('cross-site protection', () => {
    it('refuses posts from other websites', async () => {
        expect((await submit(bookingForm(), { headers: { origin: 'https://evil.example' } })).status).toBe(403);
        expect((await submit(bookingForm(), { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
        const created = await submit(bookingForm());
        expect((await setStatus(created.data.id, 'approved', null, { origin: 'https://evil.example' })).status).toBe(403);
    });

    it('allows posts from the app itself', async () => {
        expect((await submit(bookingForm(), { headers: { origin: 'https://booking.test' } })).status).toBe(200);
        expect((await submit(bookingForm(), { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    });
});

describe('failed-login limit', () => {
    it('blocks repeated wrong passwords but never a correct login', async () => {
        const ip = '192.0.2.77';
        let last;
        for (let i = 0; i < 12; i++) last = await call('/', { auth: WRONG, ip });
        expect(last.status).toBe(429);
        expect((await call('/', { auth: USER, ip })).status).toBe(200);
        expect((await call('/', { auth: null, ip })).status).toBe(401);
    });
});

describe('upload cleanup', () => {
    it('deletes files for old events and stray files, keeps current ones', async () => {
        const put = (key) => env.UPLOADS.put(key, 'x');
        const oldKey = 'a'.repeat(24) + '-old.png';
        const keepKey = 'b'.repeat(24) + '-keep.png';
        const strayKey = 'c'.repeat(24) + '-stray.png';
        await Promise.all([put(oldKey), put(keepKey), put(strayKey)]);
        const base = {
            eventName: 'Old', eventSpace: 'fleck-atrium', registrationTime: '09:00', startTime: '09:00',
            endTime: '10:00', shutdownTime: '10:00', contactName: 'A', contactEmail: 'a@example.com', recordingOption: 'none'
        };
        const old = (await store().create({ ...base, eventDate: addDays(todayInToronto(), -200), uploadKey: oldKey })).booking;
        const keep = (await store().create({ ...base, eventDate: nextDate(), uploadKey: keepKey })).booking;

        // Two days from now, so the stray file counts as abandoned
        await purgeOldUploads(env, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));
        expect(await env.UPLOADS.head(oldKey)).toBeNull();
        expect(await env.UPLOADS.head(strayKey)).toBeNull();
        expect(await env.UPLOADS.head(keepKey)).not.toBeNull();
        expect((await store().get(old.id)).uploadKey).toBeNull();
        expect((await store().get(keep.id)).uploadKey).toBe(keepKey);
    });
});

describe('running under a path (rotmanav.ca/book)', () => {
    const book = { BASE_PATH: '/book' };

    it('redirects /book to /book/ and serves the app under it', async () => {
        const bare = await call('/book', { envOverride: book });
        expect(bare.status).toBe(301);
        expect(bare.headers.get('location')).toBe('https://booking.test/book/');
        expect((await call('/book/', { envOverride: book })).status).toBe(200);
        expect((await call('/book/admin', { auth: ADMIN, envOverride: book })).status).toBe(200);
        expect((await call('/book/health', { auth: null, envOverride: book })).status).toBe(200);
        expect((await call('/', { envOverride: book })).status).toBe(404);
        expect((await call('/bookings', { envOverride: book })).status).toBe(404);
    });

    it('takes bookings and puts the path in email links', async () => {
        const res = await call('/book/api/submit', {
            method: 'POST', envOverride: book,
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(bookingForm())
        });
        expect(res.status).toBe(200);
        expect(staffMail().html).toContain(`https://booking.test/book/admin#booking-${res.data.id}`);
    });
});
