import { describe, it, expect } from 'vitest';
import {
    validateEmail, validateTimeOrder, parseEventDate, needsBudgetNumber,
    spacesClash, timesOverlap, validUpload
} from '../src/validate.js';
import { formatEventSpace, formatRecordingOption, sanitizeForEmail, generateICS } from '../src/mail.js';
import { unfold } from './helpers.js';

describe('formatting', () => {
    it('names spaces and recording options', () => {
        expect(formatEventSpace('full')).toBe('Event Hall Full');
        expect(formatEventSpace('fleck-atrium')).toBe('Fleck Atrium');
        expect(formatEventSpace('unknown')).toBe('unknown');
        expect(formatRecordingOption('basic-recording')).toBe('Basic Recording - Fixed wide shot or Zoom');
    });

    it('escapes HTML for emails', () => {
        expect(sanitizeForEmail('<script>')).toBe('&lt;script&gt;');
        expect(sanitizeForEmail('Tom & Jerry')).toBe('Tom &amp; Jerry');
        expect(sanitizeForEmail(null)).toBe('');
    });
});

describe('validateEmail', () => {
    it('accepts plain addresses', () => {
        expect(validateEmail('user@example.com')).toBe(true);
        expect(validateEmail('test@utoronto.ca')).toBe(true);
        expect(validateEmail('first.last+av@mail.rotman.utoronto.ca')).toBe(true);
    });

    it('rejects bad and quoted addresses', () => {
        expect(validateEmail('"x\r\nATTACH:http://evil"@example.com')).toBe(false);
        expect(validateEmail('"two words"@example.com')).toBe(false);
        expect(validateEmail('invalid')).toBe(false);
        expect(validateEmail('a@b')).toBe(false);
        expect(validateEmail('a..b@example.com')).toBe(false);
        expect(validateEmail('a@-bad.com')).toBe(false);
        expect(validateEmail('a@example.c0m')).toBe(false);
        expect(validateEmail('a@[127.0.0.1]')).toBe(false);
        expect(validateEmail('')).toBe(false);
        expect(validateEmail(null)).toBe(false);
    });
});

describe('validateTimeOrder', () => {
    it('accepts times in order', () => {
        expect(validateTimeOrder('08:30', '09:00', '11:30', '12:00').valid).toBe(true);
    });

    it('rejects times out of order, bad formats and zero length', () => {
        expect(validateTimeOrder('11:00', '09:00', '11:30', '12:00').message).toContain('Registration');
        expect(validateTimeOrder('08:30', '09:00', '15:00', '14:00').message).toContain('Presentation');
        expect(validateTimeOrder('8:30', '09:00', '11:30', '12:00').message).toContain('HH:MM');
        expect(validateTimeOrder('09:00', '09:00', '09:00', '09:00').valid).toBe(false);
    });
});

describe('parseEventDate', () => {
    it('accepts ISO and the form format', () => {
        expect(parseEventDate('2026-05-01')).toBe('2026-05-01');
        expect(parseEventDate('May 1, 2026')).toBe('2026-05-01');
        expect(parseEventDate('September 21, 2026')).toBe('2026-09-21');
    });

    it('rejects garbage and impossible dates', () => {
        for (const bad of ['banana', '2026-02-30', '', undefined]) expect(parseEventDate(bad)).toBeNull();
    });
});

describe('needsBudgetNumber', () => {
    it('follows regular AV hours by weekday', () => {
        expect(needsBudgetNumber('2026-10-05', '07:00', '20:00')).toBe(false); // Monday
        expect(needsBudgetNumber('2026-10-05', '06:30', '12:00')).toBe(true);
        expect(needsBudgetNumber('2026-10-09', '09:00', '18:30')).toBe(true);  // Friday
        expect(needsBudgetNumber('2026-10-10', '08:00', '17:00')).toBe(false); // Saturday
        expect(needsBudgetNumber('2026-10-11', '07:30', '12:00')).toBe(true);  // Sunday
    });
});

describe('double-booking rules', () => {
    it('treats every Event Hall set-up as one room', () => {
        expect(spacesClash('full', 'one-third')).toBe(true);
        expect(spacesClash('one-third', 'two-thirds')).toBe(true);
        expect(spacesClash('full', 'fleck-atrium')).toBe(false);
    });

    it('only clashes when times overlap (back-to-back is fine)', () => {
        const a = { registrationTime: '09:00', shutdownTime: '12:00' };
        expect(timesOverlap(a, { registrationTime: '11:00', shutdownTime: '13:00' })).toBe(true);
        expect(timesOverlap(a, { registrationTime: '12:00', shutdownTime: '13:00' })).toBe(false);
    });
});

describe('validUpload', () => {
    it('needs both an allowed extension and type', () => {
        expect(validUpload('photo.jpg', 'image/jpeg')).toBe(true);
        expect(validUpload('clip.mov', 'video/quicktime')).toBe(true);
        expect(validUpload('evil.mp4html', 'video/mp4')).toBe(false);
        expect(validUpload('photo.jpg', 'text/html')).toBe(false);
    });
});

describe('generateICS', () => {
    const booking = {
        id: 42, status: 'pending', sequence: 0,
        eventDate: '2026-05-01', registrationTime: '08:30', startTime: '09:00', endTime: '11:30', shutdownTime: '12:00',
        eventName: 'Rotman Test & Launch, Part 1', eventSpace: 'full', recordingOption: 'basic-recording',
        contactName: 'Test User', contactEmail: 'test@example.com', notes: 'Line one\r\nATTACH;X=evil:evil'
    };
    const ics = generateICS(booking);
    const unfolded = unfold(ics);

    it('uses Toronto time and valid ORGANIZER/ATTENDEE lines', () => {
        expect(unfolded).toContain('DTSTART;TZID=America/Toronto:20260501T083000');
        expect(unfolded).toContain('DTEND;TZID=America/Toronto:20260501T120000');
        expect(unfolded).toContain('BEGIN:VTIMEZONE');
        expect(unfolded).toContain('ORGANIZER;CN="Rotman AV Services":mailto:requests@rotmanav.ca');
        expect(unfolded).toContain('ATTENDEE;CN="Test User";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:test@example.com');
    });

    it('has a stable UID and marks status', () => {
        expect(unfolded).toContain('UID:booking-42@rotmanav.ca');
        expect(unfolded).toContain('STATUS:TENTATIVE');
        expect(unfold(generateICS({ ...booking, status: 'approved' }))).toContain('STATUS:CONFIRMED');
        const cancel = unfold(generateICS({ ...booking, status: 'cancelled', sequence: 2 }, 'CANCEL'));
        expect(cancel).toContain('METHOD:CANCEL');
        expect(cancel).toContain('SEQUENCE:2');
    });

    it('escapes text and cannot be injected into', () => {
        expect(unfolded).toContain('Launch\\, Part 1');
        expect(unfolded).toContain('Line one\\nATTACH');
        ics.split('\r\n').forEach((line) => expect(line).not.toMatch(/^ATTACH/i));
        const evil = unfold(generateICS({ ...booking, contactEmail: '"x\r\nATTACH:http://evil"@example.com' }));
        evil.split('\r\n').forEach((line) => expect(line).not.toMatch(/^ATTACH/));
    });

    it('folds every line to at most 75 octets', () => {
        ics.split('\r\n').forEach((line) => expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75));
    });
});
