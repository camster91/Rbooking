// Input rules shared by the booking API. Pure functions, no I/O.

export const TIME_ZONE = 'America/Toronto';
export const EVENT_SPACES = ['full', 'one-third', 'two-thirds', 'fleck-atrium'];
export const RECORDING_OPTIONS = ['none', 'basic-recording', 'live-web-recording'];

// Spaces in the same group can't be booked at the same time. The three Event
// Hall options are set-ups of one room (the 1/3 and 2/3 set-ups both use the
// front of the hall), so any two hall bookings clash. Fleck Atrium is separate.
export const SPACE_GROUPS = {
    'full': 'event-hall',
    'one-third': 'event-hall',
    'two-thirds': 'event-hall',
    'fleck-atrium': 'fleck-atrium'
};

export function spaceGroup(space) {
    return SPACE_GROUPS[space] || space;
}

export function spacesClash(a, b) {
    return spaceGroup(a) === spaceGroup(b);
}

// Times are validated HH:MM strings, so they compare correctly as text.
// A booking holds its space from registration until shutdown.
export function timesOverlap(a, b) {
    return a.registrationTime < b.shutdownTime && b.registrationTime < a.shutdownTime;
}

// Plain addresses only: no quoted local parts (they can hold spaces and line
// breaks that would break mail headers and the calendar invite), no IP-literal
// domains, and a real-looking domain with a letters-only top-level part.
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function validateEmail(email) {
    if (typeof email !== 'string' || email.length > 254) return false;
    const at = email.lastIndexOf('@');
    if (at < 1) return false;
    const local = email.slice(0, at);
    const labels = email.slice(at + 1).split('.');
    return local.length <= 64
        && LOCAL_PART.test(local)
        && labels.length >= 2
        && labels.every(label => DOMAIN_LABEL.test(label))
        && /^[A-Za-z]{2,63}$/.test(labels[labels.length - 1]);
}

const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateTimeOrder(registration, start, end, shutdown) {
    const times = [registration, start, end, shutdown];
    if (times.some(t => !t)) return { valid: false, message: 'All time fields are required' };
    if (times.some(t => typeof t !== 'string' || !TIME_FORMAT.test(t))) {
        return { valid: false, message: 'All times must be valid 24-hour HH:MM values (e.g. 09:00)' };
    }
    if (registration > start) {
        return { valid: false, message: 'Registration time must be before or at event start time' };
    }
    if (start > end) {
        return { valid: false, message: 'Event start time must be before presentation end time' };
    }
    if (end > shutdown) {
        return { valid: false, message: 'Presentation end time must be before shutdown time' };
    }
    if (registration === shutdown) {
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

export function parseEventDate(raw) {
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
// required. public/index.html shows the same rule before the user submits.
const REGULAR_HOURS = {
    0: { start: '08:00', end: '17:00' },
    5: { start: '07:00', end: '18:00' },
    6: { start: '08:00', end: '17:00' }
};
const WEEKDAY_HOURS = { start: '07:00', end: '20:00' };

export function needsBudgetNumber(isoDate, registrationTime, shutdownTime) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const hours = REGULAR_HOURS[day] || WEEKDAY_HOURS;
    return registrationTime < hours.start || shutdownTime > hours.end;
}

// Today's date in Toronto as YYYY-MM-DD (en-CA formats dates that way).
export function todayInToronto(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(now);
}

export function addDays(isoDate, days) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Trim a text field and cap its length; non-strings become ''.
export function text(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Uploads: allowed by extension and by the browser-reported type.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const UPLOAD_EXT = /\.(jpe?g|png|gif|mp4|mov|avi|webm)$/i;
const UPLOAD_TYPE = /^(image\/(p?jpe?g|png|gif)|video\/(mp4|quicktime|x-msvideo|avi|webm))$/;

export function validUpload(name, type) {
    return typeof name === 'string' && UPLOAD_EXT.test(name) && typeof type === 'string' && UPLOAD_TYPE.test(type);
}

export function safeFileName(name) {
    return String(name).replace(/[^a-zA-Z0-9.-]/g, '_').slice(-80);
}
