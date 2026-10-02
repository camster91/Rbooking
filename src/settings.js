// Settings staff can change on the admin page, stored in D1. Anything not
// saved there falls back to the vars in wrangler.jsonc and the secrets.
import { validateEmail } from './validate.js';

const encoder = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export const MIN_PASSWORD_LENGTH = 12;
const MAX_UPLOAD_LIMIT_MB = 10240;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export class SettingsError extends Error {}

// Constant-time comparison: hash both sides so the lengths always match.
export async function safeEqual(a, b) {
    const [ha, hb] = await Promise.all([
        crypto.subtle.digest('SHA-256', encoder.encode(String(a))),
        crypto.subtle.digest('SHA-256', encoder.encode(String(b)))
    ]);
    return crypto.subtle.timingSafeEqual(ha, hb);
}

// Stored as "salt:sha256(salt:password)". The login is checked on every
// request, so a slow hash would use up the free plan's CPU time.
export async function hashPassword(password, salt = hex(crypto.getRandomValues(new Uint8Array(16)))) {
    return `${salt}:${hex(await crypto.subtle.digest('SHA-256', encoder.encode(`${salt}:${password}`)))}`;
}

export async function passwordMatches(password, stored) {
    const salt = stored.slice(0, stored.indexOf(':'));
    return safeEqual(await hashPassword(password, salt), stored);
}

// "utoronto.ca, @rotman.utoronto.ca" -> ['utoronto.ca', 'rotman.utoronto.ca']
export function parseDomains(value) {
    return String(value || '').toLowerCase().split(/[\s,;]+/).map(d => d.replace(/^@/, '')).filter(Boolean);
}

// An empty list allows any address. A domain also covers its subdomains.
export function emailAllowed(email, domains) {
    const list = parseDomains(domains);
    if (!list.length) return true;
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
    return list.some(d => domain === d || domain.endsWith('.' + d));
}

export async function loadSettings(db) {
    const { results } = await db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(results.map(r => [r.key, r.value]));
}

// The env the rest of the app sees: saved settings on top of the vars.
export function applySettings(env, saved) {
    return {
        ...env,
        EMAIL_TO: saved.email_to || env.EMAIL_TO,
        UPLOAD_DAILY_LIMIT_MB: saved.upload_daily_limit_mb || env.UPLOAD_DAILY_LIMIT_MB,
        ALLOWED_EMAIL_DOMAINS: saved.allowed_email_domains ?? env.ALLOWED_EMAIL_DOMAINS ?? '',
        FORM_PASS_HASH: saved.form_password_hash || null
    };
}

// What the admin page shows. Never includes a password.
export function settingsView(env) {
    return {
        emailTo: env.EMAIL_TO || 'requests@rotmanav.ca',
        allowedEmailDomains: parseDomains(env.ALLOWED_EMAIL_DOMAINS).join(', '),
        uploadDailyLimitMb: Number(env.UPLOAD_DAILY_LIMIT_MB) > 0 ? Number(env.UPLOAD_DAILY_LIMIT_MB) : 1024,
        formPassword: env.FORM_PASS_HASH ? 'app' : 'cloudflare'
    };
}

// Checks every field first, then saves them all together. Fields that are
// left out stay as they are.
export async function saveSettings(db, input) {
    const set = {};
    const remove = [];

    if (input.emailTo !== undefined) {
        const email = String(input.emailTo).trim();
        if (!validateEmail(email)) throw new SettingsError('Please enter a valid email address for new requests');
        set.email_to = email;
    }
    if (input.allowedEmailDomains !== undefined) {
        const domains = parseDomains(input.allowedEmailDomains);
        const bad = domains.find(d => !DOMAIN.test(d));
        if (bad) throw new SettingsError(`"${bad}" is not a valid email domain`);
        if (domains.length > 20) throw new SettingsError('Please list 20 domains or fewer');
        set.allowed_email_domains = domains.join(', ');
    }
    if (input.uploadDailyLimitMb !== undefined) {
        const mb = Number(input.uploadDailyLimitMb);
        if (!Number.isInteger(mb) || mb < 1 || mb > MAX_UPLOAD_LIMIT_MB) {
            throw new SettingsError(`The daily upload limit must be a whole number from 1 to ${MAX_UPLOAD_LIMIT_MB} MB`);
        }
        set.upload_daily_limit_mb = String(mb);
    }
    if (input.useCloudflarePassword === true) {
        remove.push('form_password_hash');
    } else if (input.formPassword !== undefined && input.formPassword !== '') {
        const password = String(input.formPassword);
        if (password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
            throw new SettingsError(`The booking form password must be at least ${MIN_PASSWORD_LENGTH} characters`);
        }
        set.form_password_hash = await hashPassword(password);
    }

    const statements = [
        ...Object.entries(set).map(([key, value]) => db.prepare(
            `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(key, value)),
        ...remove.map(key => db.prepare('DELETE FROM settings WHERE key = ?').bind(key))
    ];
    if (statements.length) await db.batch(statements);
}
