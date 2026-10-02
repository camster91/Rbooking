require('dotenv').config();

// Password from env var (works better with special chars than .env)
const smtpPassword = process.env.SMTP_PASSWORD || process.env.TITAN_PASSWORD;
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const escapeHtml = require('escape-html');
const validator = require('validator');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Basic Auth — protects all pages.
// The fallback password is published in this repo's docs and history, so a
// production deployment must refuse to run on it.
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || (!IS_PRODUCTION ? 'rotman2025' : null);

if (!AUTH_PASS || AUTH_PASS === 'rotman2025') {
    if (IS_PRODUCTION) {
        console.error('FATAL: set AUTH_PASS to a strong password. NODE_ENV=production refuses the known default.');
        process.exit(1);
    }
    console.warn('WARNING: AUTH_PASS not set - using the known development default. Never deploy this.');
}

function constantTimeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function basicAuth(req, res, next) {
    const hdr = req.headers.authorization || '';
    if (hdr.slice(0, 6).toLowerCase() === 'basic ') {
        const decoded = Buffer.from(hdr.slice(6), 'base64').toString();
        // Per RFC 7617 the password is everything after the FIRST colon (a
        // password may itself contain colons).
        const colon = decoded.indexOf(':');
        const user = colon === -1 ? decoded : decoded.slice(0, colon);
        const pass = colon === -1 ? '' : decoded.slice(colon + 1);
        if (constantTimeEqual(user, AUTH_USER) && constantTimeEqual(pass, AUTH_PASS)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Rotman AV"');
    return res.status(401).send('Authentication required');
}

// Email transporter - initialized async (see initializeEmailTransporter)
let transporter = null;
// One of: 'uninitialized' | 'test' | 'smtp' | 'ethereal' | 'console'
let emailMode = 'uninitialized';

// Behind a reverse proxy every request arrives from the proxy's IP, so the
// rate limiter would lump all users together. Set TRUST_PROXY (e.g. 1 for one
// proxy hop) so req.ip is the real client address.
if (process.env.TRUST_PROXY) {
    const tp = process.env.TRUST_PROXY;
    app.set('trust proxy', tp === 'true' ? true : (/^\d+$/.test(tp) ? Number(tp) : tp));
}

// Health check endpoint - public so the container healthcheck can reach it
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        email: {
            mode: emailMode,
            configured: Boolean(transporter),
            // In production anything other than real SMTP means bookings are not delivered
            degraded: IS_PRODUCTION && emailMode !== 'smtp'
        }
    });
});

app.use(basicAuth);

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        cb(null, uniqueName);
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
    max: 10, // Limit each IP to 10 requests per windowMs
    message: { success: false, message: 'Too many booking requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadsDir));

async function initializeEmailTransporter() {
    // Use console logging in test environment
    if (process.env.NODE_ENV === 'test') {
        console.log('Test environment - using console logging mode');
        emailMode = 'test';
        transporter = {
            sendMail: async (options) => {
                console.log('Email sent (test mode):', options.subject);
                return { messageId: 'test-' + Date.now() };
            }
        };
        return;
    }

    // Production SMTP
    if (process.env.SMTP_HOST && smtpPassword) {
        try {
            transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port: parseInt(process.env.SMTP_PORT, 10) || 587,
                secure: process.env.SMTP_SECURE === 'true',
                auth: {
                    user: process.env.SMTP_USERNAME,
                    pass: smtpPassword
                }
            });
            console.log('Using production SMTP:', process.env.SMTP_HOST);

            // Verify SMTP connection
            await transporter.verify();
            console.log('SMTP connection verified successfully');
            emailMode = 'smtp';
            return;
        } catch (smtpError) {
            // In production a failed SMTP connection means every booking email
            // would be silently lost - refuse to start instead.
            if (IS_PRODUCTION) {
                throw new Error(`SMTP connection failed (${smtpError.message}) - refusing to start in production`);
            }
            console.error('SMTP configuration error:', smtpError.message);
            console.log('Falling back to Ethereal test email (development only)...');
            transporter = null;
        }
    } else if (IS_PRODUCTION) {
        throw new Error('SMTP_HOST and SMTP_PASSWORD are required in production - refusing to start without a real mail transport');
    }

    // Development fallback: the Ethereal test inbox. Messages there are thrown
    // away within hours - fine for development, catastrophic for bookings.
    try {
        const testAccount = await nodemailer.createTestAccount();
        transporter = nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            secure: false,
            auth: {
                user: testAccount.user,
                pass: testAccount.pass
            }
        });
        emailMode = 'ethereal';
        console.warn('WARNING: using the Ethereal TEST inbox - email is NOT really delivered. Preview at https://ethereal.email');
    } catch {
        emailMode = 'console';
        console.warn('WARNING: no email service available - booking emails will only be logged to the console');
        transporter = {
            sendMail: async (options) => {
                console.log('\n========== EMAIL PREVIEW ==========');
                console.log('To:', options.to);
                console.log('From:', options.from);
                console.log('Subject:', options.subject);
                console.log('====================================\n');
                return { messageId: 'console-' + Date.now() };
            }
        };
    }
}

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve thank you page
app.get('/thank-you', (req, res) => {
    res.sendFile(path.join(__dirname, 'thank_you.html'));
});

// Validation helper functions
function validateEmail(email) {
    return email && validator.isEmail(email);
}

const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateTimeOrder(registration, start, end, shutdown) {
    const times = [registration, start, end, shutdown];
    if (times.some(t => !t)) return { valid: false, message: 'All time fields are required' };
    if (times.some(t => !TIME_FORMAT.test(t))) {
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

// RFC 5545 3.1: content lines longer than 75 octets must be folded with CRLF + space.
function foldICalLine(line) {
    if (Buffer.byteLength(line, 'utf8') <= 75) return line;
    const folded = [];
    let current = '';
    let currentBytes = 0;
    for (const char of line) {
        const charBytes = Buffer.byteLength(char, 'utf8');
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

// Generate ICS calendar invite. eventDate must be a parseEventDate-validated
// YYYY-MM-DD and the times validateTimeOrder-validated HH:MM strings.
function generateICS(eventDate, eventStartTime, shutdown, eventName, eventSpace, recordingOption, personOfContact, emailAddress, otherNotes) {
    const dateCompact = eventDate.replace(/-/g, '');
    const startTime = eventStartTime.replace(':', '') + '00';
    const endTime = shutdown.replace(':', '') + '00';
    const eventId = `rotman-${Date.now()}@rotmanav.ca`;
    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    let desc = `Event Space: ${formatEventSpace(eventSpace)}\nRecording: ${formatRecordingOption(recordingOption)}\n\nContact: ${personOfContact} (${emailAddress})`;
    if (otherNotes) desc += `\n\nNotes: ${otherNotes}`;

    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Rotman AV//Booking System//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:REQUEST',
        'BEGIN:VEVENT',
        `UID:${eventId}`,
        `DTSTAMP:${now}`,
        `DTSTART:${dateCompact}T${startTime}`,
        `DTEND:${dateCompact}T${endTime}`,
        `SUMMARY:${escapeICalText(eventName || 'Untitled Event')}`,
        `DESCRIPTION:${escapeICalText(desc)}`,
        `LOCATION:${escapeICalText(`${formatEventSpace(eventSpace)} - Rotman School of Management`)}`,
        'STATUS:CONFIRMED',
        'SEQUENCE:0',
        `ORGANIZER;CN="${escapeICalParam('Rotman AV Services')}":mailto:${process.env.SMTP_USERNAME || 'requests@rotmanav.ca'}`,
        `ATTENDEE;CN="${escapeICalParam(personOfContact)}";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${emailAddress}`,
        'END:VEVENT',
        'END:VCALENDAR'
    ];
    return lines.map(foldICalLine).join('\r\n');
}

// Sanitize user input for email HTML
function sanitizeForEmail(input) {
    if (!input) return '';
    return escapeHtml(String(input));
}

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

// Handle form submission
app.post('/api/submit', submitLimiter, handleUpload, async (req, res) => {
    try {
        const {
            'event-space': eventSpace,
            'person-of-contact': personOfContact,
            'email-address': emailAddress,
            'event-date': eventDate,
            'event-name': eventName,
            'registration-time': registrationTime,
            'event-start-time': eventStartTime,
            'presentation-end-time': presentationEndTime,
            'shutdown': shutdown,
            'cc-number': ccNumber,
            'cfc-number': cfcNumber,
            'recording-option': recordingOption,
            'other-notes': otherNotes
        } = req.body;

        // Validate email
        if (!validateEmail(emailAddress)) {
            return res.status(400).json({ success: false, message: 'Please provide a valid email address' });
        }

        // Validate event date (accepts both the UI's "May 1, 2026" and ISO YYYY-MM-DD)
        const isoDate = parseEventDate(eventDate);
        if (!isoDate) {
            return res.status(400).json({ success: false, message: 'Please provide a valid event date' });
        }

        // Validate time format and order
        const timeValidation = validateTimeOrder(registrationTime, eventStartTime, presentationEndTime, shutdown);
        if (!timeValidation.valid) {
            return res.status(400).json({ success: false, message: timeValidation.message });
        }

        // Sanitize inputs for email HTML
        const sanitized = {
            eventName: sanitizeForEmail(eventName),
            personOfContact: sanitizeForEmail(personOfContact),
            emailAddress: sanitizeForEmail(emailAddress),
            eventDate: sanitizeForEmail(eventDate),
            ccNumber: sanitizeForEmail(ccNumber),
            cfcNumber: sanitizeForEmail(cfcNumber),
            otherNotes: sanitizeForEmail(otherNotes),
            // format* echo unknown values back unchanged, so escape them too
            eventSpace: sanitizeForEmail(formatEventSpace(eventSpace)),
            recordingOption: sanitizeForEmail(formatRecordingOption(recordingOption)),
        };

        const fileName = req.file ? req.file.filename : null;
        const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;

        // Build email HTML
        const emailHtml = `
            <html>
            <body style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0;">
                    <h1 style="margin: 0;">Rotman AV Event Booking</h1>
                    <p style="margin: 10px 0 0; opacity: 0.9;">New booking request received</p>
                </div>

                <div style="background: #f8f9fa; padding: 30px; border: 1px solid #e9ecef;">
                    <h2 style="color: #495057; border-bottom: 2px solid #667eea; padding-bottom: 10px;">${sanitized.eventName || 'Untitled Event'}</h2>

                    <table style="width: 100%; border-collapse: collapse;">
                        <tr style="border-bottom: 1px solid #dee2e6;">
                            <td style="padding: 12px 0; color: #6c757d; width: 40%;">Event Space</td>
                            <td style="padding: 12px 0; font-weight: 500;">${sanitized.eventSpace}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #dee2e6;">
                            <td style="padding: 12px 0; color: #6c757d;">Contact Person</td>
                            <td style="padding: 12px 0; font-weight: 500;">${sanitized.personOfContact}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #dee2e6;">
                            <td style="padding: 12px 0; color: #6c757d;">Email</td>
                            <td style="padding: 12px 0;"><a href="mailto:${sanitized.emailAddress}">${sanitized.emailAddress}</a></td>
                        </tr>
                        <tr style="border-bottom: 1px solid #dee2e6;">
                            <td style="padding: 12px 0; color: #6c757d;">Event Date</td>
                            <td style="padding: 12px 0; font-weight: 500;">${sanitized.eventDate}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #dee2e6;">
                            <td style="padding: 12px 0; color: #6c757d;">Recording Option</td>
                            <td style="padding: 12px 0; font-weight: 500;">${sanitized.recordingOption}</td>
                        </tr>
                    </table>

                    <h3 style="color: #495057; margin-top: 25px;">Schedule</h3>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; background: white; padding: 15px; border-radius: 8px;">
                        <div><span style="color: #6c757d; display: block; font-size: 12px;">Registration</span><strong>${registrationTime}</strong></div>
                        <div><span style="color: #6c757d; display: block; font-size: 12px;">Event Start</span><strong>${eventStartTime}</strong></div>
                        <div><span style="color: #6c757d; display: block; font-size: 12px;">Presentation End</span><strong>${presentationEndTime}</strong></div>
                        <div><span style="color: #6c757d; display: block; font-size: 12px;">Shutdown</span><strong>${shutdown}</strong></div>
                    </div>

                    ${(sanitized.ccNumber || sanitized.cfcNumber) ? `
                    <h3 style="color: #495057; margin-top: 25px;">Budget Numbers</h3>
                    <div style="background: white; padding: 15px; border-radius: 8px;">
                        ${sanitized.ccNumber ? `<p style="margin: 5px 0;"><strong>CC#:</strong> ${sanitized.ccNumber}</p>` : ''}
                        ${sanitized.cfcNumber ? `<p style="margin: 5px 0;"><strong>CFC#:</strong> ${sanitized.cfcNumber}</p>` : ''}
                    </div>
                    ` : ''}

                    ${sanitized.otherNotes ? `
                    <h3 style="color: #495057; margin-top: 25px;">Additional Notes</h3>
                    <div style="background: white; padding: 15px; border-radius: 8px;">
                        <p style="margin: 0; white-space: pre-wrap;">${sanitized.otherNotes}</p>
                    </div>
                    ` : ''}

                    ${fileName ? `
                    <h3 style="color: #495057; margin-top: 25px;">Attached Media</h3>
                    <div style="background: white; padding: 15px; border-radius: 8px;">
                        <a href="${baseUrl}/uploads/${fileName}" style="color: #667eea;">View Uploaded File</a>
                    </div>
                    ` : ''}
                </div>

                <div style="background: #495057; color: white; padding: 15px; text-align: center; border-radius: 0 0 10px 10px; font-size: 12px;">
                    Rotman AV Services
                </div>
            </body>
            </html>
        `;

        // Send email with calendar invite
        const mailOptions = {
            from: `"Rotman AV" <${process.env.SMTP_USERNAME || 'noreply@rotmanav.ca'}>`,
            to: process.env.EMAIL_TO || 'requests@rotmanav.ca',
            replyTo: emailAddress,
            subject: `📅 ${eventName || 'Untitled Event'} - ${eventDate}`,
            html: emailHtml,
            alternatives: [{
                contentType: 'text/calendar; method=REQUEST; charset=utf-8',
                // generateICS escapes per RFC 5545 itself - pass raw values, not HTML-escaped ones
                content: generateICS(isoDate, eventStartTime, shutdown, eventName, eventSpace, recordingOption, personOfContact, emailAddress, otherNotes)
            }]
        };

        const info = await transporter.sendMail(mailOptions);

        console.log(`[${new Date().toISOString()}] Booking submitted: ${eventName || 'Untitled Event'} on ${eventDate}`);

        const previewUrl = nodemailer.getTestMessageUrl(info);
        if (previewUrl) {
            console.log('Preview email at:', previewUrl);
        }

        res.json({
            success: true,
            message: 'Booking submitted successfully! Calendar invite sent.',
            previewUrl: previewUrl || null
        });

    } catch (error) {
        console.error('Error processing booking:', error.message);
        res.status(500).json({ success: false, message: 'Failed to submit booking. Please try again.' });
    }
});

// Helper functions
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

// Export for testing
module.exports = {
    app,
    initializeEmailTransporter,
    formatEventSpace,
    formatRecordingOption,
    validateEmail,
    validateTimeOrder,
    sanitizeForEmail,
    parseEventDate,
    escapeICalText,
    generateICS
};

// Start server (only if run directly)
async function startServer() {
    await initializeEmailTransporter();
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

if (require.main === module) {
    startServer().catch((err) => {
        console.error('FATAL: server failed to start:', err.message);
        process.exit(1);
    });
}
