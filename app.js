require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const validator = require('validator');

const { openBookingStore, BookingError } = require('./lib/bookings');
const mail = require('./lib/mail');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const TIME_ZONE = 'America/Toronto';

// ---------------------------------------------------------------------------
// Logins. Two levels:
//   - AUTH_USER / AUTH_PASS: shared login for the booking form
//   - ADMIN_USER / ADMIN_PASS: AV staff - the admin page and uploaded files
// The fallback passwords are published in this repo, so production refuses them.
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || (!IS_PRODUCTION ? 'rotman2025' : null);
const ADMIN_USER = process.env.ADMIN_USER || 'av-admin';
const ADMIN_PASS = process.env.ADMIN_PASS || (!IS_PRODUCTION ? 'rotman-admin-dev' : null);

if (!AUTH_PASS || AUTH_PASS === 'rotman2025') {
    if (IS_PRODUCTION) {
        console.error('FATAL: set AUTH_PASS to a strong password. NODE_ENV=production refuses the known default.');
        process.exit(1);
    }
    console.warn('WARNING: AUTH_PASS not set - using the known development default. Never deploy this.');
}
if (!ADMIN_PASS || ADMIN_PASS === 'rotman-admin-dev') {
    if (IS_PRODUCTION) {
        console.error('FATAL: set ADMIN_PASS to a strong password. NODE_ENV=production refuses the known default.');
        process.exit(1);
    }
    console.warn('WARNING: ADMIN_PASS not set - using the known development default. Never deploy this.');
}
if (ADMIN_USER === AUTH_USER) {
    console.warn('WARNING: ADMIN_USER is the same as AUTH_USER - pick a different admin username.');
}

function constantTimeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Returns 'admin', 'user' or null for the request's Basic Auth credentials.
function loginRole(req) {
    const hdr = req.headers.authorization || '';
    if (hdr.slice(0, 6).toLowerCase() !== 'basic ') return null;
    const decoded = Buffer.from(hdr.slice(6), 'base64').toString();
    // Per RFC 7617 the password is everything after the FIRST colon (a
    // password may itself contain colons).
    const colon = decoded.indexOf(':');
    const user = colon === -1 ? decoded : decoded.slice(0, colon);
    const pass = colon === -1 ? '' : decoded.slice(colon + 1);
    // Check both pairs every time so timing doesn't reveal which user exists.
    const isAdmin = constantTimeEqual(user, ADMIN_USER) & constantTimeEqual(pass, ADMIN_PASS);
    const isUser = constantTimeEqual(user, AUTH_USER) & constantTimeEqual(pass, AUTH_PASS);
    if (isAdmin) return 'admin';
    if (isUser) return 'user';
    return null;
}

// Shown if someone cancels the browser's sign-in box.
const SIGN_IN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in needed - Rotman AV</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#f1f5f9;font-family:system-ui,sans-serif;padding:16px}
main{max-width:420px;text-align:center;background:#1e293b;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:32px}
h1{font-size:1.3rem;margin:0 0 10px}p{color:#cbd5e1;margin:0 0 20px}a{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;padding:10px 22px;border-radius:10px}</style>
</head><body><main><h1>Sign in needed</h1><p>This page is for Rotman staff. Ask the AV team for the login, then try again.</p><a href="">Try again</a></main></body></html>`;

function challenge(res, realm) {
    res.set('WWW-Authenticate', `Basic realm="${realm}"`);
    return res.status(401).type('html').send(SIGN_IN_PAGE);
}

function basicAuth(req, res, next) {
    req.role = loginRole(req);
    return req.role ? next() : challenge(res, 'Rotman AV');
}

function adminAuth(req, res, next) {
    // A different realm makes the browser ask again when a form user opens /admin.
    return req.role === 'admin' ? next() : challenge(res, 'Rotman AV Admin');
}

// Behind a reverse proxy every request arrives from the proxy's IP, so the
// rate limiter would lump all users together. Set TRUST_PROXY (e.g. 1 for one
// proxy hop) so req.ip is the real client address.
// Accepts true/false, a number of proxy hops, or Express's IP/subnet list.
function parseTrustProxy(raw) {
    const value = String(raw ?? '').trim();
    if (!value || /^(false|no|off|0)$/i.test(value)) return null;
    if (/^(true|yes|on)$/i.test(value)) return true;
    if (/^\d+$/.test(value)) return Number(value);
    return value;
}

const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== null) {
    try {
        app.set('trust proxy', trustProxy);
    } catch (err) {
        throw new Error(`TRUST_PROXY="${process.env.TRUST_PROXY}" is not valid (${err.message}). Use true, a number of proxy hops, or IP addresses.`);
    }
}

// ---------------------------------------------------------------------------
// Storage

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'bookings.db');
const store = openBookingStore(DB_FILE);

const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Health check endpoint - public so the container healthcheck can reach it
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        email: mail.getEmailStatus()
    });
});

// Slow down password guessing. Only requests that send credentials and get
// them wrong are counted or blocked, so the browser's first credential-less
// request never counts, and people who log in correctly are never locked out
// by someone else guessing from the same network.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    skip: (req) => !req.headers.authorization || loginRole(req) !== null,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many failed logins. Please try again in 15 minutes.'
});

app.use(loginLimiter);
app.use(basicAuth);

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        // Random prefix so file links can't be guessed
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_').slice(-80);
        cb(null, `${crypto.randomBytes(12).toString('hex')}-${safeName}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
    fileFilter: (req, file, cb) => {
        const ext = /^\.(jpe?g|png|gif|mp4|mov|avi|webm)$/.test(path.extname(file.originalname).toLowerCase());
        const mime = /^(image\/(p?jpe?g|png|gif)|video\/(mp4|quicktime|x-msvideo|avi|webm))$/.test(file.mimetype);
        if (ext && mime) return cb(null, true);
        const err = new Error('Only JPG, PNG, GIF, MP4, MOV, AVI or WEBM files can be uploaded');
        err.status = 400;
        cb(err);
    }
});

// Rate limiting middleware
const submitLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    // Per IP. Many people can share one campus address, so this is set to
    // stop floods rather than to limit any one person.
    max: parseInt(process.env.SUBMIT_RATE_LIMIT, 10) || 30,
    message: { success: false, message: 'Too many booking requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Block cross-site POSTs (CSRF). Browsers send the saved Basic Auth login
// with any request to this site, so another website could otherwise submit
// bookings as a logged-in user. Browsers mark cross-site requests with
// Sec-Fetch-Site and Origin; requests from tools like curl send neither.
function allowedOrigins(req) {
    const hosts = new Set([req.get('host')]);
    if (app.get('trust proxy') && req.get('x-forwarded-host')) hosts.add(req.get('x-forwarded-host'));
    if (process.env.BASE_URL) {
        try { hosts.add(new URL(process.env.BASE_URL).host); } catch { /* ignore a bad BASE_URL */ }
    }
    return hosts;
}

function sameOriginOnly(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    // Modern browsers say outright whether a request is cross-site. Trust that
    // first: behind a proxy the Host the server sees may not match Origin.
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite === 'cross-site') {
        return res.status(403).json({ success: false, message: 'Cross-site requests are not allowed' });
    }
    if (fetchSite) return next();
    // Older browsers: compare Origin with this server's host names.
    const origin = req.get('origin');
    if (origin) {
        let host = null;
        try { host = new URL(origin).host; } catch { /* "null" or garbage */ }
        if (!host || !allowedOrigins(req).has(host)) {
            return res.status(403).json({ success: false, message: 'Cross-site requests are not allowed' });
        }
    }
    return next();
}

app.use(sameOriginOnly);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Uploaded files can hold anything people attach, so only staff can open them.
app.use('/uploads', adminAuth, express.static(uploadsDir));

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve thank you page
app.get('/thank-you', (req, res) => {
    res.sendFile(path.join(__dirname, 'thank_you.html'));
});

app.get('/admin', adminAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ---------------------------------------------------------------------------
// Validation

const EVENT_SPACES = ['full', 'one-third', 'two-thirds', 'fleck-atrium'];
const RECORDING_OPTIONS = ['none', 'basic-recording', 'live-web-recording'];

// validator.isEmail alone accepts quoted addresses that can hold spaces and
// line breaks ("a\r\nb"@x.com), which would break the calendar invite and
// mail headers. Only allow plain addresses.
const PLAIN_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;

function validateEmail(email) {
    return typeof email === 'string' && PLAIN_EMAIL.test(email) && validator.isEmail(email);
}

const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateTimeOrder(registration, start, end, shutdown) {
    const times = [registration, start, end, shutdown];
    if (times.some(t => !t)) return { valid: false, message: 'All time fields are required' };
    if (times.some(t => typeof t !== 'string' || !TIME_FORMAT.test(t))) {
        return { valid: false, message: 'All times must be valid 24-hour HH:MM values (e.g. 09:00)' };
    }

    const toMinutes = (time) => {
        const [hours, minutes] = time.split(':').map(Number);
        return hours * 60 + minutes;
    };

    const [regMin, startMin, endMin, shutdownMin] = times.map(toMinutes);

    if (regMin > startMin) {
        return { valid: false, message: 'Registration time must be before or at event start time' };
    }
    if (startMin > endMin) {
        return { valid: false, message: 'Event start time must be before presentation end time' };
    }
    if (endMin > shutdownMin) {
        return { valid: false, message: 'Presentation end time must be before shutdown time' };
    }
    if (regMin === shutdownMin) {
        return { valid: false, message: 'Shutdown must be after registration opens' };
    }

    return { valid: true };
}

// The UI's flatpickr submits 'F j, Y' (e.g. "May 1, 2026") while the API
// contract documents ISO dates; accept both and return normalized YYYY-MM-DD.
const MONTHS = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

function parseEventDate(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const value = raw.trim();
    let y, m, d;

    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const pretty = iso ? null : value.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
    if (iso) {
        y = Number(iso[1]); m = Number(iso[2]); d = Number(iso[3]);
    } else if (pretty) {
        m = MONTHS[pretty[1].toLowerCase()];
        d = Number(pretty[2]); y = Number(pretty[3]);
        if (!m) return null;
    } else {
        return null;
    }

    // Reject impossible dates (2026-02-30, etc.)
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
    return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Regular AV hours by weekday (0 = Sunday). Outside them a CC# or CFC# is
// required. index.html shows the same rule to the user before they submit.
const REGULAR_HOURS = {
    0: { start: '08:00', end: '17:00' },
    5: { start: '07:00', end: '18:00' },
    6: { start: '08:00', end: '17:00' }
};
const WEEKDAY_HOURS = { start: '07:00', end: '20:00' };

function needsBudgetNumber(isoDate, registrationTime, shutdownTime) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const hours = REGULAR_HOURS[day] || WEEKDAY_HOURS;
    return registrationTime < hours.start || shutdownTime > hours.end;
}

// Today's date in Toronto as YYYY-MM-DD (en-CA formats dates that way).
function todayInToronto(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now);
}

function addDays(isoDate, days) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Trim a text field and cap its length; non-strings become ''.
function text(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function baseUrl() {
    return (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
}

function removeUpload(file) {
    if (file) fs.unlink(file.path, () => {});
}

// Send an email without failing the request: the booking is already saved
// and visible on the admin page, so a mail error is logged, not fatal.
async function trySend(options, label) {
    try {
        await mail.sendMail(options);
        return true;
    } catch (err) {
        console.error(`Email failed (${label}):`, err.message);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Public API

// Run multer so its errors (file too big, wrong type) come back as JSON the
// form can show, instead of Express's HTML error page.
function handleUpload(req, res, next) {
    upload.single('media-upload')(req, res, (err) => {
        if (!err) return next();
        const message = err.code === 'LIMIT_FILE_SIZE'
            ? 'File is too large (50MB max)'
            : (err.status === 400 ? err.message : 'File upload failed');
        return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, message });
    });
}

// Times already taken on a date, for the form to show. Only the space and
// times are shared - not who booked or what the event is.
app.get('/api/availability', (req, res) => {
    const date = parseEventDate(req.query.date);
    if (!date) return res.status(400).json({ success: false, message: 'Please provide a valid date' });
    const space = EVENT_SPACES.includes(req.query.space) ? req.query.space : null;
    const probe = { id: null, eventDate: date, eventSpace: space, registrationTime: '00:00', shutdownTime: '24:00' };
    const bookings = (space ? store.findConflicts(probe) : store.activeOnDate(date)).map(b => ({
        space: b.eventSpace,
        spaceName: mail.formatEventSpace(b.eventSpace),
        from: b.registrationTime,
        to: b.shutdownTime,
        status: b.status
    }));
    res.json({ success: true, date, bookings });
});

// Handle form submission
app.post('/api/submit', submitLimiter, handleUpload, async (req, res) => {
    const fail = (status, message, extra = {}) => {
        removeUpload(req.file);
        return res.status(status).json({ success: false, message, ...extra });
    };

    try {
        const body = req.body || {};
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
            uploadFile: req.file ? req.file.filename : null
        };

        if (!validateEmail(input.contactEmail)) {
            return fail(400, 'Please provide a valid email address');
        }
        if (!input.contactName) {
            return fail(400, 'Please provide your name');
        }
        if (!input.eventName) {
            return fail(400, 'Please provide an event name');
        }

        // Validate event date (accepts both the UI's "May 1, 2026" and ISO YYYY-MM-DD)
        input.eventDate = parseEventDate(body['event-date']);
        if (!input.eventDate) {
            return fail(400, 'Please provide a valid event date');
        }
        if (input.eventDate < todayInToronto()) {
            return fail(400, 'The event date is in the past - please pick today or a later date');
        }

        if (!EVENT_SPACES.includes(input.eventSpace)) {
            return fail(400, 'Please choose an event space');
        }
        if (!RECORDING_OPTIONS.includes(input.recordingOption)) {
            return fail(400, 'Please choose a recording option');
        }

        // Validate time format and order
        const timeValidation = validateTimeOrder(input.registrationTime, input.startTime, input.endTime, input.shutdownTime);
        if (!timeValidation.valid) {
            return fail(400, timeValidation.message);
        }
        if (needsBudgetNumber(input.eventDate, input.registrationTime, input.shutdownTime) && !input.ccNumber && !input.cfcNumber) {
            return fail(400, 'Your event runs outside regular AV hours, so please add a CC# or CFC# budget number');
        }

        let created;
        try {
            created = store.create(input);
        } catch (err) {
            if (err instanceof BookingError && err.code === 'conflict') {
                const c = err.conflicts[0];
                return fail(409, `${mail.formatEventSpace(c.eventSpace)} is already booked from ${mail.formatTime(c.registrationTime)} to ${mail.formatTime(c.shutdownTime)} that day. Please pick another time or space.`);
            }
            throw err;
        }
        const { booking, conflicts } = created;

        console.log(`[${new Date().toISOString()}] Booking #${booking.id} submitted: ${booking.eventName} on ${booking.eventDate}`);

        const links = {
            adminUrl: `${baseUrl()}/admin#booking-${booking.id}`,
            uploadUrl: booking.uploadFile ? `${baseUrl()}/uploads/${booking.uploadFile}` : null
        };
        const [staffNotified, confirmationSent] = await Promise.all([
            trySend(mail.newBookingStaffEmail(booking, { conflicts, ...links }), `staff, booking #${booking.id}`),
            trySend(mail.receivedRequesterEmail(booking), `requester, booking #${booking.id}`)
        ]);

        res.json({
            success: true,
            id: booking.id,
            message: confirmationSent
                ? `Request #${booking.id} received. A confirmation email is on its way to ${booking.contactEmail}.`
                : `Request #${booking.id} received. (We couldn't send your confirmation email, but the AV team has your request.)`,
            staffNotified,
            confirmationSent
        });
    } catch (error) {
        console.error('Error processing booking:', error.message);
        removeUpload(req.file);
        res.status(500).json({ success: false, message: 'Failed to submit booking. Please try again.' });
    }
});

// ---------------------------------------------------------------------------
// Admin API

const adminApi = express.Router();
adminApi.use(adminAuth);

function adminView(b, conflicts) {
    return {
        ...b,
        spaceName: mail.formatEventSpace(b.eventSpace),
        recordingName: mail.formatRecordingOption(b.recordingOption),
        uploadUrl: b.uploadFile ? `uploads/${encodeURIComponent(b.uploadFile)}` : null,
        conflicts: (conflicts.get(b.id) || []).map(c => ({ id: c.id, eventName: c.eventName, status: c.status }))
    };
}

adminApi.get('/bookings', (req, res) => {
    const scope = ['upcoming', 'past', 'all'].includes(req.query.scope) ? req.query.scope : 'upcoming';
    const status = ['pending', 'approved', 'declined', 'cancelled'].includes(req.query.status) ? req.query.status : undefined;
    const today = todayInToronto();
    const bookings = store.list({ scope, status, today });
    const conflicts = store.conflictsFor(bookings);
    res.json({
        success: true,
        bookings: bookings.map(b => adminView(b, conflicts)),
        pendingCount: store.countPending(today)
    });
});

// One booking, so links from staff emails work however many bookings exist.
adminApi.get('/bookings/:id', (req, res) => {
    const booking = store.get(Number(req.params.id));
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    res.json({ success: true, booking: adminView(booking, store.conflictsFor([booking])) });
});

adminApi.post('/bookings/:id/status', async (req, res) => {
    // JSON only: a cross-site HTML form can't send this, which blocks CSRF.
    if (!req.is('application/json')) {
        return res.status(415).json({ success: false, message: 'Send JSON' });
    }
    const id = Number(req.params.id);
    const status = req.body.status;
    const note = text(req.body.note, 2000);
    try {
        const { booking, previousStatus } = store.setStatus(id, status, note);
        console.log(`[${new Date().toISOString()}] Booking #${id}: ${previousStatus} -> ${status}`);
        const adminUrl = `${baseUrl()}/admin#booking-${id}`;
        const [requesterNotified] = await Promise.all([
            trySend(mail.statusRequesterEmail(booking, previousStatus), `requester status, booking #${id}`),
            trySend(mail.statusStaffEmail(booking, { adminUrl }), `staff status, booking #${id}`)
        ]);
        res.json({ success: true, booking, requesterNotified });
    } catch (err) {
        if (err instanceof BookingError) {
            const code = { not_found: 404, conflict: 409, invalid_transition: 409 }[err.code] || 400;
            return res.status(code).json({ success: false, message: err.message });
        }
        console.error('Error updating booking:', err.message);
        res.status(500).json({ success: false, message: 'Could not update the booking' });
    }
});

app.use('/api/admin', adminApi);

// ---------------------------------------------------------------------------
// Upload cleanup

const UPLOAD_RETENTION_DAYS = parseInt(process.env.UPLOAD_RETENTION_DAYS, 10) || 90;

// Delete files for events more than UPLOAD_RETENTION_DAYS in the past, and
// stray files no booking points to (older than a day, so in-flight uploads
// are left alone).
function purgeOldUploads(now = new Date()) {
    let removed = 0;
    // One bad file must never stop the cleanup, let alone crash the server.
    const tryRemove = (file) => {
        try {
            const stat = fs.statSync(file, { throwIfNoEntry: false });
            if (stat && stat.isFile()) { fs.rmSync(file, { force: true }); removed++; }
        } catch (err) {
            console.error(`Upload cleanup: could not remove ${path.basename(file)}:`, err.message);
        }
    };
    try {
        const cutoff = addDays(todayInToronto(now), -UPLOAD_RETENTION_DAYS);
        for (const booking of store.withUploadBefore(cutoff)) {
            tryRemove(path.join(uploadsDir, booking.uploadFile));
            store.clearUpload(booking.id);
        }
        const referenced = store.uploadFiles();
        for (const name of fs.readdirSync(uploadsDir)) {
            if (name.startsWith('.') || referenced.has(name)) continue;
            const file = path.join(uploadsDir, name);
            const stat = fs.statSync(file, { throwIfNoEntry: false });
            if (stat && stat.isFile() && now - stat.mtimeMs > 24 * 60 * 60 * 1000) tryRemove(file);
        }
    } catch (err) {
        console.error('Upload cleanup failed:', err.message);
    }
    if (removed) console.log(`Upload cleanup: removed ${removed} file(s)`);
    return removed;
}

// Export for testing
module.exports = {
    app,
    store,
    initializeEmailTransporter: mail.initializeEmailTransporter,
    formatEventSpace: mail.formatEventSpace,
    formatRecordingOption: mail.formatRecordingOption,
    sanitizeForEmail: mail.sanitizeForEmail,
    escapeICalText: mail.escapeICalText,
    generateICS: mail.generateICS,
    sentMail: mail.sentMail,
    validateEmail,
    validateTimeOrder,
    needsBudgetNumber,
    parseTrustProxy,
    parseEventDate,
    todayInToronto,
    addDays,
    purgeOldUploads,
    uploadsDir
};

// Start server (only if run directly)
async function startServer() {
    await mail.initializeEmailTransporter();
    purgeOldUploads();
    setInterval(purgeOldUploads, 24 * 60 * 60 * 1000).unref();
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
        console.log(`Bookings database: ${DB_FILE}`);
    });
}

if (require.main === module) {
    startServer().catch((err) => {
        console.error('FATAL: server failed to start:', err.message);
        process.exit(1);
    });
}
