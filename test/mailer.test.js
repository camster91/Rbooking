import { describe, it, expect } from 'vitest';
import { buildMime, smtpSend, htmlToText, sendMail } from '../src/mailer.js';

const decodeParts = (raw) => [...raw.matchAll(/Content-Type: ([^\r\n]+)\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)]
    .map(([, type, b64]) => ({ type, body: new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\r\n/g, '')), c => c.charCodeAt(0))) }));

describe('buildMime', () => {
    const raw = buildMime({
        from: '"Rotman AV" <requests@rotmanav.ca>', fromAddress: 'requests@rotmanav.ca',
        to: 'test@example.com', replyTo: 'staff@example.com',
        subject: 'Évent\r\nBcc: evil@example.com',
        html: '<p>Hello &amp; welcome</p>',
        alternatives: [{ contentType: 'text/calendar; method=REQUEST; charset=utf-8', content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' }]
    });
    const [head] = raw.split('\r\n\r\n');

    it('encodes the subject so user text cannot add headers', () => {
        expect(head).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
        expect(head).not.toMatch(/^Bcc:/m);
        expect(head).toContain('To: <test@example.com>');
        expect(head).toContain('Reply-To: <staff@example.com>');
    });

    it('includes text, HTML and the calendar invite as alternatives', () => {
        const parts = decodeParts(raw);
        expect(parts.map(p => p.type)).toEqual([
            'text/plain; charset=UTF-8', 'text/html; charset=UTF-8', 'text/calendar; method=REQUEST; charset=utf-8'
        ]);
        expect(parts[0].body).toBe('Hello & welcome');
        expect(parts[2].body).toContain('BEGIN:VCALENDAR');
    });

    it('turns HTML into readable text', () => {
        expect(htmlToText('<h1>Hi</h1><p>A<br>B</p><style>x{}</style>')).toBe('Hi\nA\nB');
    });
});

// A pretend SMTP server: answers each command and records what it was sent.
function fakeSmtp({ offerStartTls = true, authCode = 235 } = {}) {
    const log = { commands: [], data: '', upgraded: false };
    const enc = new TextEncoder();
    function makeSocket() {
        let push;
        const readable = new ReadableStream({ start(c) { push = (s) => c.enqueue(enc.encode(s)); } });
        let inData = false;
        let buffer = '';
        const writable = new WritableStream({
            write(chunk) {
                buffer += new TextDecoder().decode(chunk);
                if (inData) {
                    const end = buffer.indexOf('\r\n.\r\n');
                    if (end === -1) return;
                    log.data = buffer.slice(0, end + 2);
                    buffer = buffer.slice(end + 5);
                    inData = false;
                    push('250 queued\r\n');
                }
                let idx;
                while (!inData && (idx = buffer.indexOf('\r\n')) !== -1) {
                    const line = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    log.commands.push(line);
                    if (line.startsWith('EHLO')) push(`250-smtp.test\r\n${offerStartTls && !log.upgraded ? '250-STARTTLS\r\n' : ''}250 AUTH PLAIN LOGIN\r\n`);
                    else if (line === 'STARTTLS') push('220 go ahead\r\n');
                    else if (line.startsWith('AUTH')) push(`${authCode} auth\r\n`);
                    else if (line.startsWith('MAIL') || line.startsWith('RCPT')) push('250 ok\r\n');
                    else if (line === 'DATA') { push('354 send\r\n'); inData = true; }
                    else if (line === 'QUIT') push('221 bye\r\n');
                }
            }
        });
        return {
            readable, writable, close: async () => {},
            startTls: () => { log.upgraded = true; const s = makeSocket(); return s; },
            greet: () => push('220 smtp.test ready\r\n')
        };
    }
    const connect = () => { const s = makeSocket(); s.greet(); return s; };
    return { connect, log };
}

describe('smtpSend', () => {
    const message = { host: 'smtp.test', port: 587, secure: false, user: 'u@x.ca', pass: 'p', from: 'u@x.ca', to: ['a@b.ca'] };

    it('upgrades to TLS, logs in, and sends with dot-stuffing', async () => {
        const { connect, log } = fakeSmtp();
        await smtpSend({ ...message, connect, raw: 'Subject: x\r\n\r\n.hidden line\r\nend\r\n' });
        expect(log.upgraded).toBe(true);
        expect(log.commands).toContain('STARTTLS');
        expect(log.commands.indexOf('STARTTLS')).toBeLessThan(log.commands.findIndex(c => c.startsWith('AUTH')));
        expect(log.commands).toContain(`AUTH PLAIN ${btoa('\0u@x.ca\0p')}`);
        expect(log.commands).toContain('MAIL FROM:<u@x.ca>');
        expect(log.commands).toContain('RCPT TO:<a@b.ca>');
        expect(log.data).toContain('\r\n..hidden line\r\n');
    });

    it('refuses to send the password without TLS', async () => {
        const { connect, log } = fakeSmtp({ offerStartTls: false });
        await expect(smtpSend({ ...message, connect, raw: 'x' })).rejects.toThrow(/STARTTLS/);
        expect(log.commands.some(c => c.startsWith('AUTH'))).toBe(false);
    });

    it('reports a failed login', async () => {
        const { connect } = fakeSmtp({ authCode: 535 });
        await expect(smtpSend({ ...message, connect, raw: 'x' })).rejects.toThrow(/login failed/);
    });
});

describe('sendMail', () => {
    it('refuses when SMTP is not configured', async () => {
        await expect(sendMail({}, { to: 'a@b.ca', subject: 's', html: 'h' })).rejects.toThrow(/not configured/);
    });

    it('sends through SMTP when configured', async () => {
        const { connect, log } = fakeSmtp();
        const env = { SMTP_HOST: 'smtp.test', SMTP_USERNAME: 'u@x.ca', SMTP_PASSWORD: 'p', SMTP_PORT: '587' };
        await sendMail(env, { to: 'a@b.ca', subject: 'Hello', html: '<p>Hi</p>' }, { connect });
        expect(log.commands).toContain('RCPT TO:<a@b.ca>');
        expect(log.data).toContain('From: "Rotman AV" <u@x.ca>');
    });
});
