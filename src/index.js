// rbooking on Cloudflare Workers.
//
// Bindings (wrangler.jsonc): DB (D1), UPLOADS (R2), ASSETS (public/),
// SUBMIT_LIMITER and LOGIN_LIMITER (rate limits).
// Secrets: AUTH_PASS, ADMIN_PASS, SMTP_PASSWORD. See README for the full list.
import { bookingStore, BookingError } from './bookings.js';
import * as mail from './mail.js';
import { sendMail, mailStatus } from './mailer.js';
import {
    EVENT_SPACES, RECORDING_OPTIONS, MAX_UPLOAD_BYTES,
    validateEmail, validateTimeOrder, parseEventDate, needsBudgetNumber,
    todayInToronto, addDays, text, validUpload, safeFileName
} from './validate.js';

// ---------------------------------------------------------------------------
// Responses

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});
const fail = (status, message, extra = {}) => json({ success: false, message, ...extra }, status);

const page = (title, heading, body, status) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} - Rotman AV</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#f1f5f9;font-family:system-ui,sans-serif;padding:16px}
main{max-width:420px;text-align:center;background:#1e293b;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:32px}
h1{font-size:1.3rem;margin:0 0 10px}p{color:#cbd5e1;margin:0 0 20px}a{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;padding:10px 22px;border-radius:10px}</style>
</head><body><main><h1>${heading}</h1>${body}</main></body></html>`, {
    status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
});

// Shown if someone cancels the browser's sign-in box.
const signInPage = () => page('Sign in needed', 'Sign in needed',
    '<p>This page is for Rotman staff. Ask the AV team for the login, then try again.</p><a href="">Try again</a>', 401);

// ---------------------------------------------------------------------------
// Logins. Two levels:
//   - AUTH_USER / AUTH_PASS: shared login for the booking form
//   - ADMIN_USER / ADMIN_PASS: AV staff - the admin page and uploaded files
// There are no built-in passwords: without AUTH_PASS and ADMIN_PASS set, the
// app refuses every request instead of running unprotected.

const encoder = new TextEncoder();

// Constant-time comparison: hash both sides so the lengths always match.
async function safeEqual(a, b) {
    const [ha, hb] = await Promise.all([
        crypto.subtle.digest('SHA-256', encoder.encode(String(a))),
        crypto.subtle.digest('SHA-256', encoder.encode(String(b)))
    ]);
    return crypto.subtle.timingSafeEqual(ha, hb);
}

function credentials(env) {
    return {
        user: env.AUTH_USER || 'admin', pass: env.AUTH_PASS,
        adminUser: env.ADMIN_USER || 'av-admin', adminPass: env.ADMIN_PASS
    };
}

// Returns 'admin', 'user' or null for the request's Basic Auth credentials.
export async function loginRole(request, env) {
    const hdr = request.headers.get('authorization') || '';
    if (hdr.slice(0, 6).toLowerCase() !== 'basic ') return null;
    let decoded;
    try {
        decoded = new TextDecoder().decode(Uint8Array.from(atob(hdr.slice(6).trim()), c => c.charCodeAt(0)));
    } catch {
        return null;
    }
    // Per RFC 7617 the password is everything after the FIRST colon.
    const colon = decoded.indexOf(':');
    const user = colon === -1 ? decoded : decoded.slice(0, colon);
    const pass = colon === -1 ? '' : decoded.slice(colon + 1);
    const c = credentials(env);
    // Check both pairs every time so timing doesn't reveal which user exists.
    const [adminUser, adminPass, formUser, formPass] = await Promise.all([
        safeEqual(user, c.adminUser), safeEqual(pass, c.adminPass),
        safeEqual(user, c.user), safeEqual(pass, c.pass)
    ]);
    if (adminUser && adminPass) return 'admin';
    if (formUser && formPass) return 'user';
    return null;
}

function challenge(realm) {
    const res = signInPage();
    res.headers.set('WWW-Authenticate', `Basic realm="${realm}"`);
    return res;
}

const clientIp = (request) => request.headers.get('cf-connecting-ip') || 'unknown';

// Rate limit binding; missing in some local setups, then no limit applies.
async function allowed(limiter, key) {
    if (!limiter) return true;
    const { success } = await limiter.limit({ key });
    return success;
}

// Block cross-site writes (CSRF). Browsers send the saved Basic Auth login
// with any request to this site, so another website could otherwise submit
// bookings as a logged-in user. Browsers mark cross-site requests with
// Sec-Fetch-Site and Origin; tools like curl send neither.
function crossSite(request) {
    const fetchSite = request.headers.get('sec-fetch-site');
    if (fetchSite) return fetchSite === 'cross-site';
    const origin = request.headers.get('origin');
    if (!origin) return false;
    try {
        return new URL(origin).host !== new URL(request.url).host;
    } catch {
        return true;
    }
}

// ---------------------------------------------------------------------------
// Helpers

// The app can live under a path on a bigger site, e.g. BASE_PATH=/book for
// rotmanav.ca/book. Pages use relative links, so they work under any prefix.
function basePath(env) {
    return (env.BASE_PATH || '').replace(/\/+$/, '');
}

function baseUrl(request, env) {
    return (env.BASE_URL || new URL(request.url).origin + basePath(env)).replace(/\/$/, '');
}

function randomHex(bytes = 12) {
    return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

const UPLOAD_KEY = /^[a-f0-9]{24}-[A-Za-z0-9._-]{1,80}$/;

async function readBody(request) {
    const type = request.headers.get('content-type') || '';
    if (type.includes('application/json')) {
        const data = await request.json().catch(() => null);
        return data && typeof data === 'object' ? data : {};
    }
    if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
        const form = await request.formData();
        const data = {};
        for (const [k, v] of form.entries()) if (typeof v === 'string') data[k] = v;
        return data;
    }
    return {};
}

// Send an email without failing the request: the booking is already saved
// and visible on the admin page, so a mail error is logged, not fatal.
async function trySend(env, message, label) {
    try {
        await sendMail(env, message);
        return true;
    } catch (err) {
        console.error(`Email failed (${label}):`, err.message);
        return false;
    }
}

function adminView(b, conflicts) {
    return {
        ...b,
        spaceName: mail.formatEventSpace(b.eventSpace),
        recordingName: mail.formatRecordingOption(b.recordingOption),
        uploadUrl: b.uploadKey ? `uploads/${encodeURIComponent(b.uploadKey)}` : null,
        conflicts: (conflicts.get(b.id) || []).map(c => ({ id: c.id, eventName: c.eventName, status: c.status }))
    };
}

// ---------------------------------------------------------------------------
// Handlers

async function availability(request, env, store) {
    const url = new URL(request.url);
    const date = parseEventDate(url.searchParams.get('date'));
    if (!date) return fail(400, 'Please provide a valid date');
    const space = url.searchParams.get('space');
    const list = EVENT_SPACES.includes(space)
        ? await store.findConflicts({ id: -1, eventDate: date, eventSpace: space, registrationTime: '00:00', shutdownTime: '24:00' })
        : await store.activeOnDate(date);
    // Only the space and times are shared - not who booked or what the event is.
    return json({
        success: true,
        date,
        bookings: list.map(b => ({
            space: b.eventSpace, spaceName: mail.formatEventSpace(b.eventSpace),
            from: b.registrationTime, to: b.shutdownTime, status: b.status
        }))
    });
}

// Total upload size allowed per day, so a leaked login can't fill storage.
function dailyUploadCap(env) {
    const mb = Number(env.UPLOAD_DAILY_LIMIT_MB);
    return Math.floor((mb > 0 ? mb : 1024) * 1024 * 1024);
}

// The file goes straight from the request into R2 as a stream, so a large
// video costs almost no Worker CPU time. The booking then refers to it by key.
async function uploadFile(request, env, store) {
    const name = decodeURIComponent(request.headers.get('x-file-name') || '');
    const type = (request.headers.get('content-type') || '').split(';')[0].trim();
    const length = Number(request.headers.get('content-length'));
    if (!validUpload(name, type)) {
        return fail(400, 'Only JPG, PNG, GIF, MP4, MOV, AVI or WEBM files can be uploaded');
    }
    if (!Number.isFinite(length) || length <= 0 || !request.body) return fail(411, 'File size missing');
    if (length > MAX_UPLOAD_BYTES) return fail(413, 'File is too large (50MB max)');
    if (!(await store.reserveUpload(todayInToronto(), length, dailyUploadCap(env)))) {
        return fail(429, 'The daily upload limit has been reached. Please email the file to the AV team instead.');
    }

    const key = `${randomHex()}-${safeFileName(name)}`;
    const { readable, writable } = new FixedLengthStream(length);
    const piping = request.body.pipeTo(writable);
    await env.UPLOADS.put(key, readable, {
        httpMetadata: { contentType: type },
        customMetadata: { originalName: name.slice(0, 200) }
    });
    await piping;
    return json({ success: true, uploadKey: key });
}

async function submit(request, env, store) {
    const body = await readBody(request);
    const input = {
        eventName: text(body['event-name'], 200),
        eventSpace: body['event-space'],
        contactName: text(body['person-of-contact'], 200),
        contactEmail: text(body['email-address'], 254),
        registrationTime: body['registration-time'],
        startTime: body['event-start-time'],
        endTime: body['presentation-end-time'],
        shutdownTime: body['shutdown'],
        recordingOption: body['recording-option'],
        ccNumber: text(body['cc-number'], 100) || null,
        cfcNumber: text(body['cfc-number'], 100) || null,
        notes: text(body['other-notes'], 5000) || null,
        uploadKey: text(body['upload-key'], 120) || null
    };

    if (!validateEmail(input.contactEmail)) return fail(400, 'Please provide a valid email address');
    if (!input.contactName) return fail(400, 'Please provide your name');
    if (!input.eventName) return fail(400, 'Please provide an event name');

    // Accepts both the form's "May 1, 2026" and ISO YYYY-MM-DD
    input.eventDate = parseEventDate(body['event-date']);
    if (!input.eventDate) return fail(400, 'Please provide a valid event date');
    if (input.eventDate < todayInToronto()) {
        return fail(400, 'The event date is in the past - please pick today or a later date');
    }
    if (!EVENT_SPACES.includes(input.eventSpace)) return fail(400, 'Please choose an event space');
    if (!RECORDING_OPTIONS.includes(input.recordingOption)) return fail(400, 'Please choose a recording option');

    const times = validateTimeOrder(input.registrationTime, input.startTime, input.endTime, input.shutdownTime);
    if (!times.valid) return fail(400, times.message);
    if (needsBudgetNumber(input.eventDate, input.registrationTime, input.shutdownTime) && !input.ccNumber && !input.cfcNumber) {
        return fail(400, 'Your event runs outside regular AV hours, so please add a CC# or CFC# budget number');
    }

    if (input.uploadKey) {
        if (!UPLOAD_KEY.test(input.uploadKey) || !(await env.UPLOADS.head(input.uploadKey))) {
            return fail(400, 'The attached file was not found - please attach it again');
        }
        if (await store.isUploadUsed(input.uploadKey)) return fail(400, 'That file is already attached to another booking');
    }

    let created;
    try {
        created = await store.create(input);
    } catch (err) {
        if (err instanceof BookingError && err.code === 'conflict') {
            const c = err.conflicts[0];
            const where = c ? `${mail.formatEventSpace(c.eventSpace)} is already booked from ${mail.formatTime(c.registrationTime)} to ${mail.formatTime(c.shutdownTime)} that day` : 'That space is already booked at that time';
            return fail(409, `${where}. Please pick another time or space.`);
        }
        throw err;
    }
    const { booking, conflicts } = created;
    console.log(`Booking #${booking.id} submitted: ${booking.eventName} on ${booking.eventDate}`);

    const base = baseUrl(request, env);
    const links = {
        adminUrl: `${base}/admin#booking-${booking.id}`,
        uploadUrl: booking.uploadKey ? `${base}/uploads/${encodeURIComponent(booking.uploadKey)}` : null
    };
    const [staffNotified, confirmationSent] = await Promise.all([
        trySend(env, mail.newBookingStaffEmail(booking, { conflicts, ...links }), `staff, booking #${booking.id}`),
        trySend(env, mail.receivedRequesterEmail(booking), `requester, booking #${booking.id}`)
    ]);

    return json({
        success: true,
        id: booking.id,
        message: confirmationSent
            ? `Request #${booking.id} received. A confirmation email is on its way to ${booking.contactEmail}.`
            : `Request #${booking.id} received. (We couldn't send your confirmation email, but the AV team has your request.)`,
        staffNotified,
        confirmationSent
    });
}

async function adminList(request, env, store) {
    const url = new URL(request.url);
    const scope = ['upcoming', 'past', 'all'].includes(url.searchParams.get('scope')) ? url.searchParams.get('scope') : 'upcoming';
    const status = ['pending', 'approved', 'declined', 'cancelled'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : undefined;
    const today = todayInToronto();
    const bookings = await store.list({ scope, status, today });
    const conflicts = await store.conflictsFor(bookings);
    return json({
        success: true,
        bookings: bookings.map(b => adminView(b, conflicts)),
        pendingCount: await store.countPending(today)
    });
}

async function adminOne(id, store) {
    const booking = await store.get(id);
    if (!booking) return fail(404, 'Booking not found');
    return json({ success: true, booking: adminView(booking, await store.conflictsFor([booking])) });
}

async function adminSetStatus(request, env, store, id) {
    // JSON only: a cross-site HTML form can't send this.
    if (!(request.headers.get('content-type') || '').includes('application/json')) return fail(415, 'Send JSON');
    const body = await request.json().catch(() => ({}));
    try {
        const { booking, previousStatus } = await store.setStatus(id, body.status, text(body.note, 2000));
        console.log(`Booking #${id}: ${previousStatus} -> ${booking.status}`);
        const adminUrl = `${baseUrl(request, env)}/admin#booking-${id}`;
        const [requesterNotified] = await Promise.all([
            trySend(env, mail.statusRequesterEmail(booking, previousStatus), `requester status, booking #${id}`),
            trySend(env, mail.statusStaffEmail(booking, { adminUrl }), `staff status, booking #${id}`)
        ]);
        return json({ success: true, booking, requesterNotified });
    } catch (err) {
        if (err instanceof BookingError) {
            const code = { not_found: 404, conflict: 409, invalid_transition: 409 }[err.code] || 400;
            return fail(code, err.message);
        }
        throw err;
    }
}

async function serveUpload(env, key) {
    if (!UPLOAD_KEY.test(key)) return new Response('Not found', { status: 404 });
    const obj = await env.UPLOADS.get(key);
    if (!obj) return new Response('Not found', { status: 404 });
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('etag', obj.httpEtag);
    headers.set('x-content-type-options', 'nosniff');
    headers.set('cache-control', 'private, no-store');
    headers.set('content-disposition', `inline; filename="${key.slice(25)}"`);
    return new Response(obj.body, { headers });
}

// ---------------------------------------------------------------------------
// Upload cleanup (daily cron)

export async function purgeOldUploads(env, now = new Date()) {
    const store = bookingStore(env.DB);
    const retention = parseInt(env.UPLOAD_RETENTION_DAYS, 10) || 90;
    let removed = 0;
    try {
        const cutoff = addDays(todayInToronto(now), -retention);
        for (const booking of await store.withUploadBefore(cutoff)) {
            await env.UPLOADS.delete(booking.uploadKey);
            await store.clearUpload(booking.id);
            removed++;
        }
        // Files no booking points to (an abandoned or rejected form), once
        // they are a day old so uploads in progress are left alone.
        const used = await store.uploadKeys();
        let cursor;
        do {
            const page = await env.UPLOADS.list({ cursor, limit: 1000 });
            const stale = page.objects
                .filter(o => !used.has(o.key) && now - o.uploaded > 24 * 60 * 60 * 1000)
                .map(o => o.key);
            if (stale.length) { await env.UPLOADS.delete(stale); removed += stale.length; }
            cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        // Old daily upload totals are no longer needed.
        await store.clearUploadLog(addDays(todayInToronto(now), -7));
    } catch (err) {
        console.error('Upload cleanup failed:', err.message);
    }
    if (removed) console.log(`Upload cleanup: removed ${removed} file(s)`);
    return removed;
}

// ---------------------------------------------------------------------------
// Router

async function route(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    mail.configureMail(env);

    let path = url.pathname;
    const prefix = basePath(env);
    if (prefix) {
        // "/book" -> "/book/" so the pages' relative links resolve under it
        if (path === prefix) return Response.redirect(`${url.origin}${prefix}/${url.search}`, 301);
        if (!path.startsWith(prefix + '/')) return new Response('Not found', { status: 404 });
        path = path.slice(prefix.length);
    }

    // Public: lets uptime monitors check the app without a login.
    if (path === '/health') {
        return json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            configured: Boolean(env.AUTH_PASS && env.ADMIN_PASS),
            email: mailStatus(env)
        });
    }

    if (!env.AUTH_PASS || !env.ADMIN_PASS) {
        return page('Not set up', 'Not set up yet', '<p>The AUTH_PASS and ADMIN_PASS secrets must be set before this app can be used.</p>', 503);
    }

    const role = await loginRole(request, env);
    if (!role) {
        // Only wrong passwords count toward the limit, so a first visit (no
        // login yet) or a correct login is never blocked.
        if (request.headers.get('authorization') && !(await allowed(env.LOGIN_LIMITER, `login:${clientIp(request)}`))) {
            return new Response('Too many failed logins. Please try again in a minute.', { status: 429 });
        }
        return challenge('Rotman AV');
    }
    const requireAdmin = () => (role === 'admin' ? null : challenge('Rotman AV Admin'));

    if (!['GET', 'HEAD'].includes(method) && crossSite(request)) {
        return fail(403, 'Cross-site requests are not allowed');
    }

    const store = bookingStore(env.DB);

    // Pages (served from public/ through the assets binding)
    if (method === 'GET' || method === 'HEAD') {
        if (path === '/' ) return env.ASSETS.fetch(new URL('/', request.url));
        if (path === '/thank-you') return env.ASSETS.fetch(new URL('/thank_you', request.url));
        if (path === '/admin') return requireAdmin() || env.ASSETS.fetch(new URL('/admin', request.url));
        if (path.startsWith('/uploads/')) return requireAdmin() || serveUpload(env, decodeURIComponent(path.slice(9)));
        if (path === '/api/availability') return availability(request, env, store);
        if (path === '/api/admin/bookings') return requireAdmin() || adminList(request, env, store);
        const one = path.match(/^\/api\/admin\/bookings\/(\d+)$/);
        if (one) return requireAdmin() || adminOne(Number(one[1]), store);
    }

    if (method === 'PUT' && path === '/api/uploads') {
        if (!(await allowed(env.SUBMIT_LIMITER, `submit:${clientIp(request)}`))) return fail(429, 'Too many requests. Please wait a minute and try again.');
        return uploadFile(request, env, store);
    }
    if (method === 'POST' && path === '/api/submit') {
        if (!(await allowed(env.SUBMIT_LIMITER, `submit:${clientIp(request)}`))) return fail(429, 'Too many booking requests. Please wait a minute and try again.');
        return submit(request, env, store);
    }
    const status = path.match(/^\/api\/admin\/bookings\/(\d+)\/status$/);
    if (method === 'POST' && status) return requireAdmin() || adminSetStatus(request, env, store, Number(status[1]));

    return path.startsWith('/api/') ? fail(404, 'Not found') : new Response('Not found', { status: 404 });
}

// Sent on every response. The pages may not be shown inside another site
// (so a hidden frame can't trick staff into clicking Approve), and full
// addresses aren't leaked to other sites through links.
const SECURITY_HEADERS = {
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin'
};

function withSecurityHeaders(res) {
    const out = new Response(res.body, res);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
    return out;
}

export default {
    async fetch(request, env) {
        let res;
        try {
            res = await route(request, env);
        } catch (err) {
            console.error('Unhandled error:', err.stack || err.message);
            res = new URL(request.url).pathname.startsWith('/api/')
                ? fail(500, 'Something went wrong. Please try again.')
                : new Response('Something went wrong', { status: 500 });
        }
        return withSecurityHeaders(res);
    },

    async scheduled(controller, env, ctx) {
        ctx.waitUntil(purgeOldUploads(env));
    }
};
