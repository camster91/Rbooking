// Booking storage (SQLite) and double-booking rules.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const STATUSES = ['pending', 'approved', 'declined', 'cancelled'];
// Bookings in these states hold their room and time.
const ACTIVE_STATUSES = ['pending', 'approved'];

// Which status changes an admin may make.
const TRANSITIONS = {
    pending: ['approved', 'declined', 'cancelled'],
    approved: ['cancelled'],
    declined: [],
    cancelled: []
};

// Spaces in the same group can't be booked at the same time. The three Event
// Hall options are set-ups of one room (the 1/3 and 2/3 set-ups both use the
// front of the hall), so any two hall bookings clash. Fleck Atrium is separate.
const SPACE_GROUPS = {
    'full': 'event-hall',
    'one-third': 'event-hall',
    'two-thirds': 'event-hall',
    'fleck-atrium': 'fleck-atrium'
};

function spacesClash(a, b) {
    return (SPACE_GROUPS[a] || a) === (SPACE_GROUPS[b] || b);
}

// Times are validated HH:MM strings, so they compare correctly as text.
// A booking holds its space from registration until shutdown.
function timesOverlap(a, b) {
    return a.registrationTime < b.shutdownTime && b.registrationTime < a.shutdownTime;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    status_note TEXT,
    sequence INTEGER NOT NULL DEFAULT 0,
    event_name TEXT NOT NULL,
    event_space TEXT NOT NULL,
    event_date TEXT NOT NULL,
    registration_time TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    shutdown_time TEXT NOT NULL,
    contact_name TEXT NOT NULL,
    contact_email TEXT NOT NULL,
    cc_number TEXT,
    cfc_number TEXT,
    recording_option TEXT NOT NULL,
    notes TEXT,
    upload_file TEXT
);
CREATE INDEX IF NOT EXISTS bookings_date ON bookings (event_date, status);
`;

function fromRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        status: row.status,
        statusNote: row.status_note,
        sequence: row.sequence,
        eventName: row.event_name,
        eventSpace: row.event_space,
        eventDate: row.event_date,
        registrationTime: row.registration_time,
        startTime: row.start_time,
        endTime: row.end_time,
        shutdownTime: row.shutdown_time,
        contactName: row.contact_name,
        contactEmail: row.contact_email,
        ccNumber: row.cc_number,
        cfcNumber: row.cfc_number,
        recordingOption: row.recording_option,
        notes: row.notes,
        uploadFile: row.upload_file
    };
}

class BookingError extends Error {
    constructor(code, message, extra = {}) {
        super(message);
        this.code = code;
        Object.assign(this, extra);
    }
}

function openBookingStore(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);

    const stmts = {
        get: db.prepare('SELECT * FROM bookings WHERE id = ?'),
        activeBetween: db.prepare(`SELECT * FROM bookings WHERE event_date BETWEEN ? AND ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) ORDER BY event_date, registration_time`),
        countPending: db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE status = \'pending\' AND event_date >= ?'),
        activeOnDate: db.prepare(`SELECT * FROM bookings WHERE event_date = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) ORDER BY registration_time`),
        insert: db.prepare(`INSERT INTO bookings (
            created_at, updated_at, status, event_name, event_space, event_date,
            registration_time, start_time, end_time, shutdown_time,
            contact_name, contact_email, cc_number, cfc_number, recording_option, notes, upload_file
        ) VALUES (
            @now, @now, 'pending', @eventName, @eventSpace, @eventDate,
            @registrationTime, @startTime, @endTime, @shutdownTime,
            @contactName, @contactEmail, @ccNumber, @cfcNumber, @recordingOption, @notes, @uploadFile
        )`),
        setStatus: db.prepare('UPDATE bookings SET status = ?, status_note = ?, sequence = sequence + 1, updated_at = ? WHERE id = ?'),
        withUploadBefore: db.prepare('SELECT * FROM bookings WHERE upload_file IS NOT NULL AND event_date < ?'),
        clearUpload: db.prepare('UPDATE bookings SET upload_file = NULL WHERE id = ?'),
        allUploads: db.prepare('SELECT upload_file FROM bookings WHERE upload_file IS NOT NULL')
    };

    // Active bookings that clash with `booking` (same day, same space group,
    // overlapping time), not counting the booking itself.
    function findConflicts(booking) {
        return stmts.activeOnDate.all(booking.eventDate, ...ACTIVE_STATUSES)
            .map(fromRow)
            .filter(other => other.id !== booking.id
                && spacesClash(other.eventSpace, booking.eventSpace)
                && timesOverlap(other, booking));
    }

    // Check and insert in one transaction so two requests can't both take the
    // same slot. A clash with an approved booking is refused; a clash with a
    // pending one is allowed and reported, so an admin can pick between them.
    const create = db.transaction((input) => {
        const conflicts = findConflicts(input);
        const approved = conflicts.filter(c => c.status === 'approved');
        if (approved.length) {
            throw new BookingError('conflict', 'That space is already booked at that time', { conflicts: approved });
        }
        const info = stmts.insert.run({
            ccNumber: null, cfcNumber: null, notes: null, uploadFile: null,
            ...input,
            now: new Date().toISOString()
        });
        return { booking: fromRow(stmts.get.get(info.lastInsertRowid)), conflicts };
    });

    const setStatus = db.transaction((id, status, note) => {
        const booking = fromRow(stmts.get.get(id));
        if (!booking) throw new BookingError('not_found', 'Booking not found');
        if (!STATUSES.includes(status)) throw new BookingError('invalid', 'Unknown status');
        if (!TRANSITIONS[booking.status].includes(status)) {
            throw new BookingError('invalid_transition', `A ${booking.status} booking can't be ${status}`);
        }
        if (status === 'approved') {
            const approved = findConflicts(booking).filter(c => c.status === 'approved');
            if (approved.length) {
                throw new BookingError('conflict', `Clashes with approved booking #${approved[0].id} - cancel that one first`, { conflicts: approved });
            }
        }
        stmts.setStatus.run(status, note || null, new Date().toISOString(), id);
        return { booking: fromRow(stmts.get.get(id)), previousStatus: booking.status };
    });

    function list({ scope = 'upcoming', status, today } = {}) {
        const where = [];
        const params = [];
        if (scope === 'upcoming') { where.push('event_date >= ?'); params.push(today); }
        if (scope === 'past') { where.push('event_date < ?'); params.push(today); }
        if (status) { where.push('status = ?'); params.push(status); }
        // Upcoming: soonest first. Past and all: newest first, so the cap
        // drops the oldest bookings, never the newest.
        const order = scope === 'upcoming' ? 'ASC' : 'DESC';
        const sql = `SELECT * FROM bookings ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY event_date ${order}, registration_time ${order} LIMIT 500`;
        return db.prepare(sql).all(...params).map(fromRow);
    }

    // Conflicts for many bookings with one query: load every active booking
    // in the date range once, then match in memory. Returns Map id -> list.
    function conflictsFor(bookings) {
        const result = new Map();
        const active = bookings.filter(b => ACTIVE_STATUSES.includes(b.status));
        if (!active.length) return result;
        const dates = active.map(b => b.eventDate).sort();
        const byDate = new Map();
        for (const other of stmts.activeBetween.all(dates[0], dates[dates.length - 1], ...ACTIVE_STATUSES).map(fromRow)) {
            if (!byDate.has(other.eventDate)) byDate.set(other.eventDate, []);
            byDate.get(other.eventDate).push(other);
        }
        for (const b of active) {
            result.set(b.id, (byDate.get(b.eventDate) || []).filter(other => other.id !== b.id
                && spacesClash(other.eventSpace, b.eventSpace)
                && timesOverlap(other, b)));
        }
        return result;
    }

    return {
        db,
        conflictsFor,
        countPending: (today) => stmts.countPending.get(today).n,
        get: (id) => fromRow(stmts.get.get(id)),
        create,
        setStatus,
        list,
        findConflicts,
        activeOnDate: (date) => stmts.activeOnDate.all(date, ...ACTIVE_STATUSES).map(fromRow),
        withUploadBefore: (date) => stmts.withUploadBefore.all(date).map(fromRow),
        clearUpload: (id) => stmts.clearUpload.run(id),
        uploadFiles: () => new Set(stmts.allUploads.all().map(r => r.upload_file)),
        close: () => db.close()
    };
}

module.exports = {
    openBookingStore,
    BookingError,
    spacesClash,
    timesOverlap,
    STATUSES,
    ACTIVE_STATUSES,
    SPACE_GROUPS
};
