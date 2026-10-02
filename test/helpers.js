// Shared helpers: call the Worker directly with the test environment.
import { env } from 'cloudflare:workers';
import worker from '../src/index.js';
import { todayInToronto, addDays } from '../src/validate.js';

export { env };
export const ORIGIN = 'https://booking.test';

const basic = (user, pass) => 'Basic ' + btoa(`${user}:${pass}`);
export const USER = basic('test-user', 'test-pass');
export const ADMIN = basic('test-admin', 'test-admin-pass');
export const WRONG = basic('nobody', 'wrong');

// Each call gets its own client IP unless one is given, so the per-IP
// rate limits only apply in the test that checks them.
let ipCounter = 0;

export async function call(path, { method = 'GET', auth = USER, headers = {}, body, ip, envOverride } = {}) {
    const h = new Headers(headers);
    if (auth) h.set('authorization', auth);
    h.set('cf-connecting-ip', ip || `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`);
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body }), envOverride ? { ...env, ...envOverride } : env);
    const type = res.headers.get('content-type') || '';
    res.data = type.includes('json') ? await res.json() : await res.text();
    return res;
}

// Each booking gets its own future date so bookings never clash by accident.
let dayOffset = 10;
export const nextDate = () => addDays(todayInToronto(), dayOffset++);
export { todayInToronto, addDays };

export function bookingForm(overrides = {}) {
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

export const submit = (form, { headers = {}, ...opts } = {}) => call('/api/submit', {
    method: 'POST',
    body: new URLSearchParams(form),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    ...opts
});

export const setStatus = (id, status, note, headers = {}) => call(`/api/admin/bookings/${id}/status`, {
    method: 'POST', auth: ADMIN,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ status, note })
});

export async function upload(name, type, bytes = new Uint8Array(2048)) {
    return call('/api/uploads', {
        method: 'PUT', body: bytes,
        headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name), 'content-length': String(bytes.length) }
    });
}

export const unfold = (ics) => ics.split('\r\n ').join('');
