// Sending email from a Worker: builds the MIME message and speaks SMTP over a
// TCP socket (cloudflare:sockets) to the mail server in SMTP_HOST (Titan).
//
// Modes (env.MAIL_MODE):
//   test - keep messages in `sentMail` (used by the test suite)
//   log  - print a summary instead of sending (local development)
//   otherwise SMTP, which needs SMTP_HOST, SMTP_USERNAME and SMTP_PASSWORD.

// Messages "sent" in test mode, newest last.
export const sentMail = [];

export function mailStatus(env) {
    if (env.MAIL_MODE === 'test' || env.MAIL_MODE === 'log') return { mode: env.MAIL_MODE, configured: true };
    const configured = Boolean(env.SMTP_HOST && env.SMTP_USERNAME && env.SMTP_PASSWORD);
    return { mode: 'smtp', configured, degraded: !configured };
}

export async function sendMail(env, message, { connect } = {}) {
    if (env.MAIL_MODE === 'test') {
        sentMail.push(message);
        return { messageId: `test-${sentMail.length}` };
    }
    const from = env.SMTP_USERNAME || 'noreply@rotmanav.ca';
    if (env.MAIL_MODE === 'log' || !mailStatus(env).configured) {
        console.log(`[mail:${env.MAIL_MODE || 'not configured'}] to=${message.to} subject=${message.subject}`);
        if (env.MAIL_MODE === 'log') return { messageId: 'log' };
        throw new Error('SMTP is not configured (SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD)');
    }
    const port = parseInt(env.SMTP_PORT, 10) || 587;
    const secure = env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465;
    const raw = buildMime({ ...message, from: `"Rotman AV" <${from}>`, fromAddress: from });
    if (!connect) ({ connect } = await import('cloudflare:sockets'));
    await smtpSend({
        host: env.SMTP_HOST, port, secure,
        user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD,
        from, to: [message.to], raw, connect
    });
    return { messageId: 'smtp' };
}

// ---------------------------------------------------------------------------
// MIME

const encoder = new TextEncoder();

function base64(str) {
    const bytes = encoder.encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

function wrap76(b64) {
    return b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

// RFC 2047: always encode, so user text in a subject can never add headers.
function encodeHeader(value) {
    return `=?UTF-8?B?${base64(String(value))}?=`;
}

// Addresses are validated before they get here; strip anything that could
// still break a header line.
function cleanAddress(value) {
    return String(value ?? '').replace(/[\r\n<>",;]/g, '');
}

export function htmlToText(html) {
    return String(html)
        .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h\d|tr|li|table)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .trim();
}

function randomId() {
    return [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function buildMime(message) {
    const boundary = `=_rbooking_${randomId()}`;
    const domain = (message.fromAddress || 'rotmanav.ca').split('@')[1] || 'rotmanav.ca';
    const headers = [
        `From: ${message.from}`,
        `To: <${cleanAddress(message.to)}>`,
        message.replyTo ? `Reply-To: <${cleanAddress(message.replyTo)}>` : null,
        `Subject: ${encodeHeader(message.subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${randomId()}@${domain}>`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`
    ].filter(Boolean);

    const parts = [
        { type: 'text/plain; charset=UTF-8', body: message.text || htmlToText(message.html) },
        { type: 'text/html; charset=UTF-8', body: message.html },
        ...(message.alternatives || []).map(a => ({ type: a.contentType, body: a.content }))
    ];

    const lines = [...headers, ''];
    for (const part of parts) {
        lines.push(`--${boundary}`, `Content-Type: ${part.type}`, 'Content-Transfer-Encoding: base64', '', wrap76(base64(part.body)));
    }
    lines.push(`--${boundary}--`, '');
    return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// SMTP client (RFC 5321) over cloudflare:sockets

const decoder = new TextDecoder();
const SMTP_TIMEOUT_MS = 20000;

function lineReader(socket) {
    const reader = socket.readable.getReader();
    let buffer = '';
    // Reads one full reply (all "250-..." lines up to "250 ...").
    return {
        async reply() {
            const lines = [];
            for (;;) {
                let idx;
                while ((idx = buffer.indexOf('\r\n')) === -1) {
                    const { value, done } = await reader.read();
                    if (done) throw new Error('SMTP server closed the connection');
                    buffer += decoder.decode(value, { stream: true });
                }
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                lines.push(line);
                if (/^\d{3}(?: |$)/.test(line)) {
                    return { code: Number(line.slice(0, 3)), text: lines.join('\n') };
                }
            }
        },
        release() { try { reader.releaseLock(); } catch { /* already released */ } }
    };
}

function withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`SMTP timed out (${what})`)), ms); })
    ]).finally(() => clearTimeout(timer));
}

export async function smtpSend({ host, port, secure, user, pass, from, to, raw, connect }) {
    let socket = connect({ hostname: host, port }, { secureTransport: secure ? 'on' : 'starttls', allowHalfOpen: false });
    let writer = socket.writable.getWriter();
    let reader = lineReader(socket);

    const send = (line) => writer.write(encoder.encode(line + '\r\n'));
    const expect = async (codes, what) => {
        const res = await withTimeout(reader.reply(), SMTP_TIMEOUT_MS, what);
        if (!codes.includes(res.code)) throw new Error(`SMTP ${what} failed: ${res.text}`);
        return res;
    };
    const command = async (line, codes, what) => { await send(line); return expect(codes, what); };

    try {
        await expect([220], 'greeting');
        let ehlo = await command('EHLO rbooking.workers.dev', [250], 'EHLO');
        if (!secure) {
            if (!/STARTTLS/i.test(ehlo.text)) throw new Error('SMTP server does not offer STARTTLS; refusing to send the password in plain text');
            await command('STARTTLS', [220], 'STARTTLS');
            writer.releaseLock();
            reader.release();
            socket = socket.startTls();
            writer = socket.writable.getWriter();
            reader = lineReader(socket);
            ehlo = await command('EHLO rbooking.workers.dev', [250], 'EHLO after STARTTLS');
        }
        if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text) || !/AUTH[ =][^\n]*LOGIN/i.test(ehlo.text)) {
            await command(`AUTH PLAIN ${base64(`\0${user}\0${pass}`)}`, [235], 'login');
        } else {
            await command('AUTH LOGIN', [334], 'login');
            await command(base64(user), [334], 'login');
            await command(base64(pass), [235], 'login');
        }
        await command(`MAIL FROM:<${cleanAddress(from)}>`, [250], 'MAIL FROM');
        for (const rcpt of to) await command(`RCPT TO:<${cleanAddress(rcpt)}>`, [250, 251], 'RCPT TO');
        await command('DATA', [354], 'DATA');
        // Dot-stuffing: a line starting with "." gets an extra "."
        const body = raw.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
        await writer.write(encoder.encode(body.endsWith('\r\n') ? body : body + '\r\n'));
        await command('.', [250], 'message');
        await send('QUIT').catch(() => {});
    } finally {
        try { await socket.close(); } catch { /* ignore */ }
    }
}
