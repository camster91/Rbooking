require('dotenv').config();
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const escapeHtml = require('escape-html');
const validator = require('validator');

const app = express();
const PORT = process.env.PORT || 3000;

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
        const allowed = /jpeg|jpg|png|gif|mp4|mov|avi|webm/;
        const ext = allowed.test(path.extname(file.originalname).toLowerCase());
        const mime = allowed.test(file.mimetype);
        cb(null, ext && mime);
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
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadsDir));

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        email: transporter ? 'configured' : 'not configured'
    });
});

// Email transporter - initialized async
let transporter = null;

async function initializeEmailTransporter() {
    // Use console logging in test environment
    if (process.env.NODE_ENV === 'test') {
        console.log('Test environment - using console logging mode');
        transporter = {
            sendMail: async (options) => {
                console.log('Email sent (test mode):', options.subject);
                return { messageId: 'test-' + Date.now() };
            }
        };
        return;
    }

    // Check if using production SMTP
    if (process.env.SMTP_HOST && process.env.SMTP_PASSWORD) {
        try {
            transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port: parseInt(process.env.SMTP_PORT) || 587,
                secure: process.env.SMTP_SECURE === 'true',
                auth: {
                    user: process.env.SMTP_USERNAME,
                    pass: process.env.SMTP_PASSWORD
                }
            });
            console.log('Using production SMTP:', process.env.SMTP_HOST);
            console.log('SMTP Port:', process.env.SMTP_PORT);
            console.log('SMTP Secure:', process.env.SMTP_SECURE);

            // Verify SMTP connection
            await transporter.verify();
            console.log('SMTP connection verified successfully');
        } catch (smtpError) {
            console.error('SMTP configuration error:', smtpError.message);
            console.log('Falling back to Ethereal test email...');
            transporter = null;
        }
    }

    // Fallback if no production SMTP or SMTP failed
    if (!transporter) {
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
            console.log('Using Ethereal test email');
            console.log('View sent emails at: https://ethereal.email');
            console.log('Login:', testAccount.user);
        } catch (err) {
            console.log('No email service available - using console logging mode');
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

function validateTimeOrder(registration, start, end, shutdown) {
    const times = [registration, start, end, shutdown];
    if (times.some(t => !t)) return { valid: false, message: 'All time fields are required' };

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

// Sanitize user input for email HTML
function sanitizeForEmail(input) {
    if (!input) return '';
    return escapeHtml(String(input));
}

// Handle form submission
app.post('/api/submit', submitLimiter, upload.single('media-upload'), async (req, res) => {
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

        // Validate time order
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
                            <td style="padding: 12px 0; font-weight: 500;">${formatEventSpace(eventSpace)}</td>
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
                            <td style="padding: 12px 0; font-weight: 500;">${formatRecordingOption(recordingOption)}</td>
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

        // Send email
        const mailOptions = {
            from: `"AV Booking Form" <${process.env.SMTP_USERNAME || 'noreply@rotmanav.ca'}>`,
            to: process.env.EMAIL_TO || 'requests@rotmanav.ca',
            replyTo: emailAddress,
            subject: `New Event Request: ${eventName || 'Untitled Event'}`,
            html: emailHtml
        };

        const info = await transporter.sendMail(mailOptions);

        console.log(`[${new Date().toISOString()}] Booking submitted: ${eventName || 'Untitled Event'} on ${eventDate}`);

        const previewUrl = nodemailer.getTestMessageUrl(info);
        if (previewUrl) {
            console.log('Preview email at:', previewUrl);
        }

        res.json({
            success: true,
            message: 'Booking submitted successfully!',
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
    sanitizeForEmail
};

// Start server (only if run directly)
async function startServer() {
    await initializeEmailTransporter();
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

if (require.main === module) {
    startServer().catch(console.error);
}