// Email templates and calendar invites (ICS). Pure functions: sending is in
// mailer.js. Every user value goes through sanitizeForEmail or the ICS escapers.

// Addresses used in templates; set from the Worker environment per request.
const cfg = {
    staffEmail: 'requests@rotmanav.ca',
    organizer: 'requests@rotmanav.ca'
};

export function configureMail(env) {
    cfg.staffEmail = env.EMAIL_TO || 'requests@rotmanav.ca';
    cfg.organizer = env.SMTP_USERNAME || cfg.staffEmail;
}

// ---------------------------------------------------------------------------
// Display helpers

function formatEventSpace(space) {
    const spaces = {
        'full': 'Event Hall Full',
        'one-third': 'Event Hall 1/3',
        'two-thirds': 'Event Hall 2/3',
        'fleck-atrium': 'Fleck Atrium'
    };
    return spaces[space] || space;
}

function formatRecordingOption(option) {
    const options = {
        'none': 'None - Technician on site only',
        'basic-recording': 'Basic Recording - Fixed wide shot or Zoom',
        'live-web-recording': 'Live Web Recording - Full setup with additional technician'
    };
    return options[option] || option;
}

// "2026-05-01" -> "Friday, May 1, 2026"
function formatDate(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
    });
}

// "17:30" -> "5:30 PM"
function formatTime(time) {
    const [h, m] = time.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// Sanitize user input for email HTML
function sanitizeForEmail(input) {
    if (!input) return '';
    return String(input).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Calendar invites (RFC 5545)

// RFC 5545 TEXT escaping: backslash, semicolon, comma; embedded newlines
// become a literal escape sequence so they can never forge new properties.
function escapeICalText(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r\n|\r|\n/g, '\\n');
}

// RFC 5545 param values cannot hold quotes or backslashes at all: strip them.
function escapeICalParam(value) {
    return String(value ?? '')
        .replace(/["\\]/g, '')
        .replace(/[\r\n]+/g, ' ');
}

const utf8Length = (str) => new TextEncoder().encode(str).length;

// RFC 5545 3.1: content lines longer than 75 octets must be folded with CRLF + space.
function foldICalLine(line) {
    if (utf8Length(line) <= 75) return line;
    const folded = [];
    let current = '';
    let currentBytes = 0;
    for (const char of line) {
        const charBytes = utf8Length(char);
        if (currentBytes + charBytes > 75) {
            folded.push(current);
            current = ' ';
            currentBytes = 1;
        }
        current += char;
        currentBytes += charBytes;
    }
    folded.push(current);
    return folded.join('\r\n');
}

// Times are Toronto wall-clock times. Without a time zone, calendar apps
// would show them in each viewer's own zone.
const TIME_ZONE = 'America/Toronto';
const VTIMEZONE = [
    'BEGIN:VTIMEZONE',
    `TZID:${TIME_ZONE}`,
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0400',
    'TZNAME:EDT',
    'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0500',
    'TZNAME:EST',
    'DTSTART:19701101T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE'
];

// Build an invite for a stored booking. The UID is stable per booking and
// SEQUENCE goes up on every status change, so calendar apps update or remove
// the same event instead of adding a new one. method: 'REQUEST' | 'CANCEL'.
function generateICS(booking, method = 'REQUEST') {
    const dateCompact = booking.eventDate.replace(/-/g, '');
    const toICalTime = (t) => t.replace(':', '') + '00';
    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const status = method === 'CANCEL' ? 'CANCELLED' : (booking.status === 'approved' ? 'CONFIRMED' : 'TENTATIVE');
    const space = formatEventSpace(booking.eventSpace);

    let desc = `Booking #${booking.id} (${booking.status})\n`
        + `Event Space: ${space}\nRecording: ${formatRecordingOption(booking.recordingOption)}\n\n`
        + `Registration: ${formatTime(booking.registrationTime)}\nEvent start: ${formatTime(booking.startTime)}\n`
        + `Presentation end: ${formatTime(booking.endTime)}\nShutdown: ${formatTime(booking.shutdownTime)}\n\n`
        + `Contact: ${booking.contactName} (${booking.contactEmail})`;
    if (booking.notes) desc += `\n\nNotes: ${booking.notes}`;

    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Rotman AV//Booking System//EN',
        'CALSCALE:GREGORIAN',
        `METHOD:${method}`,
        ...VTIMEZONE,
        'BEGIN:VEVENT',
        `UID:booking-${booking.id}@rotmanav.ca`,
        `DTSTAMP:${now}`,
        `DTSTART;TZID=${TIME_ZONE}:${dateCompact}T${toICalTime(booking.registrationTime)}`,
        `DTEND;TZID=${TIME_ZONE}:${dateCompact}T${toICalTime(booking.shutdownTime)}`,
        `SUMMARY:${escapeICalText(booking.eventName)}`,
        `DESCRIPTION:${escapeICalText(desc)}`,
        `LOCATION:${escapeICalText(`${space} - Rotman School of Management`)}`,
        `STATUS:${status}`,
        `SEQUENCE:${booking.sequence}`,
        `ORGANIZER;CN="${escapeICalParam('Rotman AV Services')}":mailto:${safeMailto(cfg.organizer)}`,
        `ATTENDEE;CN="${escapeICalParam(booking.contactName)}";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${safeMailto(booking.contactEmail)}`,
        'END:VEVENT',
        'END:VCALENDAR'
    ];
    return lines.map(foldICalLine).join('\r\n');
}

// Keep only characters that are safe in a mailto: address. Addresses are
// validated before they are stored; this is a second line of defence so a
// value can never add lines to the invite.
function safeMailto(address) {
    return String(address ?? '').replace(/[^A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]/g, '');
}

function calendarAlternative(booking, method) {
    return [{
        contentType: `text/calendar; method=${method}; charset=utf-8`,
        content: generateICS(booking, method)
    }];
}

// ---------------------------------------------------------------------------
// Email templates. Every user value goes through sanitizeForEmail.

const STATUS_LABELS = {
    pending: 'Pending review',
    approved: 'Approved',
    declined: 'Declined',
    cancelled: 'Cancelled'
};

function layout(title, subtitle, body) {
    return `
        <html>
        <body style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #212529;">
            <div style="background: #00355f; color: white; padding: 28px 30px; border-radius: 10px 10px 0 0;">
                <h1 style="margin: 0; font-size: 22px;">${title}</h1>
                <p style="margin: 8px 0 0; opacity: 0.85;">${subtitle}</p>
            </div>
            <div style="background: #f8f9fa; padding: 30px; border: 1px solid #e9ecef;">
                ${body}
            </div>
            <div style="background: #495057; color: white; padding: 15px; text-align: center; border-radius: 0 0 10px 10px; font-size: 12px;">
                Rotman AV Services
            </div>
        </body>
        </html>
    `;
}

function row(label, value) {
    return `<tr style="border-bottom: 1px solid #dee2e6;">
        <td style="padding: 10px 0; color: #6c757d; width: 40%; vertical-align: top;">${label}</td>
        <td style="padding: 10px 0; font-weight: 500;">${value}</td>
    </tr>`;
}

function section(title, html) {
    return `<h3 style="color: #495057; margin: 25px 0 10px; font-size: 16px;">${title}</h3>
        <div style="background: white; padding: 15px; border-radius: 8px;">${html}</div>`;
}

function bookingDetails(booking, { forStaff = false, uploadUrl = null } = {}) {
    const s = (v) => sanitizeForEmail(v);
    let html = `
        <h2 style="color: #495057; border-bottom: 2px solid #00355f; padding-bottom: 10px; margin-top: 0;">${s(booking.eventName)}</h2>
        <table style="width: 100%; border-collapse: collapse;">
            ${row('Reference', `#${booking.id}`)}
            ${row('Status', s(STATUS_LABELS[booking.status] || booking.status))}
            ${row('Event Date', s(formatDate(booking.eventDate)))}
            ${row('Event Space', s(formatEventSpace(booking.eventSpace)))}
            ${row('Recording', s(formatRecordingOption(booking.recordingOption)))}
            ${row('Contact', `${s(booking.contactName)}<br><a href="mailto:${s(booking.contactEmail)}">${s(booking.contactEmail)}</a>`)}
        </table>
        ${section('Schedule', `<table style="width: 100%; border-collapse: collapse;">
            ${row('Registration', formatTime(booking.registrationTime))}
            ${row('Event Start', formatTime(booking.startTime))}
            ${row('Presentation End', formatTime(booking.endTime))}
            ${row('Shutdown', formatTime(booking.shutdownTime))}
        </table>`)}
    `;
    if (booking.ccNumber || booking.cfcNumber) {
        html += section('Budget Numbers', `
            ${booking.ccNumber ? `<p style="margin: 5px 0;"><strong>CC#:</strong> ${s(booking.ccNumber)}</p>` : ''}
            ${booking.cfcNumber ? `<p style="margin: 5px 0;"><strong>CFC#:</strong> ${s(booking.cfcNumber)}</p>` : ''}
        `);
    }
    if (booking.notes) {
        html += section('Additional Notes', `<p style="margin: 0; white-space: pre-wrap;">${s(booking.notes)}</p>`);
    }
    if (forStaff && uploadUrl) {
        html += section('Attached Media', `<a href="${s(uploadUrl)}" style="color: #2563eb;">View uploaded file</a> (admin login needed)`);
    }
    return html;
}

function button(href, label) {
    return `<p style="margin: 25px 0 0; text-align: center;">
        <a href="${sanitizeForEmail(href)}" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">${label}</a>
    </p>`;
}

function conflictWarning(conflicts) {
    if (!conflicts.length) return '';
    const items = conflicts.map(c =>
        `<li>#${c.id} ${sanitizeForEmail(c.eventName)} - ${sanitizeForEmail(formatEventSpace(c.eventSpace))}, ${formatTime(c.registrationTime)}-${formatTime(c.shutdownTime)} (${c.status})</li>`
    ).join('');
    return `<div style="background: #fff3cd; border: 1px solid #ffe69c; color: #664d03; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
        <strong>Possible double booking.</strong> This request overlaps:
        <ul style="margin: 8px 0 0; padding-left: 20px;">${items}</ul>
    </div>`;
}

// Staff: a new request came in. Includes a tentative calendar invite.
function newBookingStaffEmail(booking, { conflicts = [], adminUrl, uploadUrl }) {
    return {
        to: cfg.staffEmail,
        replyTo: booking.contactEmail,
        subject: `📅 New request #${booking.id}: ${booking.eventName} - ${formatDate(booking.eventDate)}`,
        html: layout('New Booking Request', `Request #${booking.id} is waiting for review`,
            conflictWarning(conflicts)
            + bookingDetails(booking, { forStaff: true, uploadUrl })
            + button(adminUrl, 'Review in admin')),
        alternatives: calendarAlternative(booking, 'REQUEST')
    };
}

// Requester: we got your request (not confirmed yet).
function receivedRequesterEmail(booking) {
    return {
        to: booking.contactEmail,
        replyTo: cfg.staffEmail,
        subject: `We received your AV booking request #${booking.id}`,
        html: layout('Request Received', 'Thanks - the AV team will review it shortly',
            `<p style="margin-top: 0;">Hi ${sanitizeForEmail(booking.contactName)},</p>
            <p>We got your request. <strong>It is not confirmed yet.</strong> You'll get another email with a calendar invite once the AV team approves it.</p>`
            + bookingDetails(booking)
            + '<p style="margin: 25px 0 0; color: #6c757d;">Need to change something? Just reply to this email.</p>')
    };
}

const STATUS_MESSAGES = {
    approved: { title: 'Booking Approved', subtitle: 'Your AV booking is confirmed', text: 'Good news - your booking is <strong>approved</strong>. A calendar invite is attached.' },
    declined: { title: 'Booking Declined', subtitle: 'The AV team could not take this booking', text: 'Sorry - the AV team <strong>could not approve</strong> this booking.' },
    cancelled: { title: 'Booking Cancelled', subtitle: 'This AV booking has been cancelled', text: 'This booking has been <strong>cancelled</strong>.' }
};

// Requester: an admin approved, declined or cancelled the booking.
function statusRequesterEmail(booking, previousStatus) {
    const msg = STATUS_MESSAGES[booking.status];
    const note = booking.statusNote
        ? `<div style="background: white; border-left: 4px solid #00355f; padding: 12px 15px; margin: 15px 0;"><strong>Note from the AV team:</strong><br><span style="white-space: pre-wrap;">${sanitizeForEmail(booking.statusNote)}</span></div>`
        : '';
    const mail = {
        to: booking.contactEmail,
        replyTo: cfg.staffEmail,
        subject: `AV booking #${booking.id} ${booking.status}: ${booking.eventName}`,
        html: layout(msg.title, msg.subtitle,
            `<p style="margin-top: 0;">Hi ${sanitizeForEmail(booking.contactName)},</p><p>${msg.text}</p>${note}`
            + bookingDetails(booking)
            + '<p style="margin: 25px 0 0; color: #6c757d;">Questions? Just reply to this email.</p>')
    };
    // Only an approved booking ever reached the requester's calendar.
    if (booking.status === 'approved') mail.alternatives = calendarAlternative(booking, 'REQUEST');
    if (booking.status === 'cancelled' && previousStatus === 'approved') mail.alternatives = calendarAlternative(booking, 'CANCEL');
    return mail;
}

// Staff: keep the team calendar in step (confirm, or remove the tentative event).
function statusStaffEmail(booking, { adminUrl }) {
    const method = booking.status === 'approved' ? 'REQUEST' : 'CANCEL';
    return {
        to: cfg.staffEmail,
        subject: `Booking #${booking.id} ${booking.status}: ${booking.eventName} - ${formatDate(booking.eventDate)}`,
        html: layout(`Booking #${booking.id} ${STATUS_LABELS[booking.status].toLowerCase()}`, 'Calendar update attached',
            bookingDetails(booking, { forStaff: true }) + button(adminUrl, 'Open admin')),
        alternatives: calendarAlternative(booking, method)
    };
}

export {
    formatEventSpace,
    formatRecordingOption,
    formatDate,
    formatTime,
    sanitizeForEmail,
    escapeICalText,
    generateICS,
    newBookingStaffEmail,
    receivedRequesterEmail,
    statusRequesterEmail,
    statusStaffEmail
};
