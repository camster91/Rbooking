import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sentMail } from '../src/mailer.js';
import { hashPassword, passwordMatches, emailAllowed } from '../src/settings.js';
import { env, call, submit, bookingForm, ADMIN, USER } from './helpers.js';

const save = (settings, { auth = ADMIN, headers = {} } = {}) => call('/api/admin/settings', {
    method: 'POST', auth,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(settings)
});
const basic = (user, pass) => 'Basic ' + btoa(`${user}:${pass}`);

beforeEach(() => { sentMail.length = 0; });
afterEach(() => env.DB.prepare('DELETE FROM settings').run());

describe('settings rules', () => {
    it('hashes passwords with a salt and checks them', async () => {
        const stored = await hashPassword('correct horse battery');
        expect(stored).not.toContain('correct');
        expect(await hashPassword('correct horse battery')).not.toBe(stored);
        expect(await passwordMatches('correct horse battery', stored)).toBe(true);
        expect(await passwordMatches('wrong horse battery', stored)).toBe(false);
    });

    it('matches email domains and their subdomains', () => {
        expect(emailAllowed('a@example.com', '')).toBe(true);
        expect(emailAllowed('a@utoronto.ca', 'utoronto.ca')).toBe(true);
        expect(emailAllowed('a@Rotman.Utoronto.ca', '@utoronto.ca')).toBe(true);
        expect(emailAllowed('a@notutoronto.ca', 'utoronto.ca')).toBe(false);
        expect(emailAllowed('a@gmail.com', 'utoronto.ca, rotman.ca')).toBe(false);
    });
});

describe('settings page', () => {
    it('is for staff only', async () => {
        expect((await call('/api/admin/settings')).status).toBe(401);
        expect((await save({ emailTo: 'x@example.com' }, { auth: USER })).status).toBe(401);
    });

    it('shows the current settings without any password', async () => {
        const res = await call('/api/admin/settings', { auth: ADMIN });
        expect(res.status).toBe(200);
        expect(res.data.settings).toEqual({
            emailTo: 'requests@rotmanav.ca', allowedEmailDomains: '', uploadDailyLimitMb: 1024, formPassword: 'cloudflare'
        });
    });

    it('sends new requests to the saved address', async () => {
        expect((await save({ emailTo: 'av-desk@example.com' })).status).toBe(200);
        expect((await submit(bookingForm())).status).toBe(200);
        expect(sentMail.some(m => m.to === 'av-desk@example.com')).toBe(true);
        expect(sentMail.some(m => m.to === 'requests@rotmanav.ca')).toBe(false);
    });

    it('only takes requests from the listed email domains', async () => {
        const res = await save({ allowedEmailDomains: 'UofT.example, @rotman.test' });
        expect(res.data.settings.allowedEmailDomains).toBe('uoft.example, rotman.test');

        const refused = await submit(bookingForm({ 'email-address': 'someone@gmail.com' }));
        expect(refused.status).toBe(400);
        expect(refused.data.message).toBe('Please use an email address ending in uoft.example or rotman.test');
        expect(sentMail).toHaveLength(0);

        expect((await submit(bookingForm({ 'email-address': 'a@mail.uoft.example' }))).status).toBe(200);

        // Clearing the list allows any address again
        await save({ allowedEmailDomains: '' });
        expect((await submit(bookingForm({ 'email-address': 'someone@gmail.com' }))).status).toBe(200);
    });

    it('changes the booking form password, and can go back to the Cloudflare one', async () => {
        const res = await save({ formPassword: 'a-new-form-password' });
        expect(res.data.settings.formPassword).toBe('app');
        const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'form_password_hash'").first();
        expect(row.value).not.toContain('a-new-form-password');

        expect((await call('/', { auth: USER })).status).toBe(401);
        expect((await call('/', { auth: basic('test-user', 'a-new-form-password') })).status).toBe(200);
        // The staff login is not affected
        expect((await call('/admin', { auth: ADMIN })).status).toBe(200);

        await save({ useCloudflarePassword: true });
        expect((await call('/', { auth: USER })).status).toBe(200);
        expect((await call('/', { auth: basic('test-user', 'a-new-form-password') })).status).toBe(401);
    });

    it('applies the saved upload limit', async () => {
        await save({ uploadDailyLimitMb: 1 });
        const send = (size) => call('/api/uploads', {
            method: 'PUT', body: new Uint8Array(size),
            headers: { 'content-type': 'image/png', 'x-file-name': 'a.png', 'content-length': String(size) }
        });
        // Whatever earlier tests uploaded today, 2MB is over a 1MB limit
        expect((await send(2 * 1024 * 1024)).status).toBe(429);
    });

    it('refuses bad values and saves nothing', async () => {
        for (const bad of [
            { emailTo: 'not an email' },
            { allowedEmailDomains: 'utoronto' },
            { uploadDailyLimitMb: 0 },
            { uploadDailyLimitMb: 2.5 },
            { formPassword: 'short' },
            { emailTo: 'ok@example.com', formPassword: 'short' }
        ]) {
            const res = await save(bad);
            expect(res.status, JSON.stringify(bad)).toBe(400);
        }
        expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM settings').first()).n).toBe(0);
    });

    it('only accepts JSON from the admin page itself', async () => {
        const form = await call('/api/admin/settings', {
            method: 'POST', auth: ADMIN,
            headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'emailTo=x%40example.com'
        });
        expect(form.status).toBe(415);
        const cross = await save({ emailTo: 'x@example.com' }, { headers: { 'sec-fetch-site': 'cross-site' } });
        expect(cross.status).toBe(403);
    });
});
