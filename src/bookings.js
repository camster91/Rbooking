// Booking storage on Cloudflare D1, and the double-booking rules.
import { spaceGroup, spacesClash, timesOverlap } from './validate.js';

export const STATUSES = ['pending', 'approved', 'declined', 'cancelled'];
// Bookings in these states hold their room and time.
export const ACTIVE_STATUSES = ['pending', 'approved'];

// Which status changes an admin may make.
const TRANSITIONS = {
    pending: ['approved', 'declined', 'cancelled'],
    approved: ['cancelled'],
    declined: [],
    cancelled: []
};

export class BookingError extends Error {
    constructor(code, message, extra = {}) {
        super(message);
        this.code = code;
        Object.assign(this, extra);
    }
}

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
        uploadKey: row.upload_key
    };
}

// SQL for "an approved booking holds this space group at an overlapping time".
// Used inside INSERT/UPDATE statements so the check and the write happen in
// one statement: D1 runs statements one at a time, so two requests can never
// both take the same slot.
const APPROVED_CLASH = `SELECT 1 FROM bookings o
    WHERE o.event_date = ?1 AND o.space_group = ?2 AND o.status = 'approved'
      AND o.registration_time < ?4 AND ?3 < o.shutdown_time AND o.id != ?5`;

export function bookingStore(db) {
    const all = async (sql, ...params) => (await db.prepare(sql).bind(...params).all()).results.map(fromRow);
    const first = async (sql, ...params) => fromRow(await db.prepare(sql).bind(...params).first());

    const get = (id) => first('SELECT * FROM bookings WHERE id = ?', id);

    // Active bookings that clash with `booking`, not counting itself.
    async function findConflicts(booking) {
        const rows = await all(
            `SELECT * FROM bookings WHERE event_date = ? AND space_group = ? AND status IN ('pending', 'approved')
             ORDER BY registration_time`,
            booking.eventDate, spaceGroup(booking.eventSpace));
        return rows.filter(other => other.id !== booking.id && timesOverlap(other, booking));
    }

    // Insert unless an approved booking already holds the slot. A clash with a
    // pending request is allowed and reported, so an admin can pick between them.
    async function create(input) {
        const now = new Date().toISOString();
        const group = spaceGroup(input.eventSpace);
        const row = await db.prepare(
            `INSERT INTO bookings (
                created_at, updated_at, status, event_name, event_space, space_group, event_date,
                registration_time, start_time, end_time, shutdown_time,
                contact_name, contact_email, cc_number, cfc_number, recording_option, notes, upload_key
            )
            SELECT ?6, ?6, 'pending', ?7, ?8, ?2, ?1, ?3, ?9, ?10, ?4, ?11, ?12, ?13, ?14, ?15, ?16, ?17
            WHERE NOT EXISTS (${APPROVED_CLASH})
            RETURNING *`
        ).bind(
            input.eventDate, group, input.registrationTime, input.shutdownTime, -1, now,
            input.eventName, input.eventSpace, input.startTime, input.endTime,
            input.contactName, input.contactEmail, input.ccNumber ?? null, input.cfcNumber ?? null,
            input.recordingOption, input.notes ?? null, input.uploadKey ?? null
        ).first();

        if (!row) {
            const approved = (await findConflicts({ ...input, id: -1 })).filter(c => c.status === 'approved');
            throw new BookingError('conflict', 'That space is already booked at that time', { conflicts: approved });
        }
        const booking = fromRow(row);
        return { booking, conflicts: await findConflicts(booking) };
    }

    async function setStatus(id, status, note) {
        const booking = await get(id);
        if (!booking) throw new BookingError('not_found', 'Booking not found');
        if (!STATUSES.includes(status)) throw new BookingError('invalid', 'Unknown status');
        if (!TRANSITIONS[booking.status].includes(status)) {
            throw new BookingError('invalid_transition', `A ${booking.status} booking can't be ${status}`);
        }
        const now = new Date().toISOString();
        // Only update if the status is still what we just read, and (for an
        // approval) no approved booking clashes, in the same statement.
        const guard = status === 'approved' ? `AND NOT EXISTS (${APPROVED_CLASH})` : '';
        const row = await db.prepare(
            `UPDATE bookings SET status = ?6, status_note = ?7, sequence = sequence + 1, updated_at = ?8
             WHERE id = ?5 AND status = ?9 ${guard}
             RETURNING *`
        ).bind(
            booking.eventDate, spaceGroup(booking.eventSpace), booking.registrationTime, booking.shutdownTime,
            id, status, note || null, now, booking.status
        ).first();

        if (!row) {
            const current = await get(id);
            if (current && current.status !== booking.status) {
                throw new BookingError('invalid_transition', `Booking #${id} was just changed to ${current.status} - refresh and try again`);
            }
            const approved = (await findConflicts(booking)).filter(c => c.status === 'approved');
            const other = approved[0];
            throw new BookingError('conflict', `Clashes with approved booking #${other ? other.id : '?'} - cancel that one first`, { conflicts: approved });
        }
        return { booking: fromRow(row), previousStatus: booking.status };
    }

    async function list({ scope = 'upcoming', status, today } = {}) {
        const where = [];
        const params = [];
        if (scope === 'upcoming') { where.push('event_date >= ?'); params.push(today); }
        if (scope === 'past') { where.push('event_date < ?'); params.push(today); }
        if (status) { where.push('status = ?'); params.push(status); }
        // Upcoming: soonest first. Past and all: newest first, so the cap
        // drops the oldest bookings, never the newest.
        const order = scope === 'upcoming' ? 'ASC' : 'DESC';
        return all(`SELECT * FROM bookings ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY event_date ${order}, registration_time ${order} LIMIT 500`, ...params);
    }

    // Conflicts for many bookings with one query: load every active booking
    // in the date range once, then match in memory. Returns Map id -> list.
    async function conflictsFor(bookings) {
        const result = new Map();
        const active = bookings.filter(b => ACTIVE_STATUSES.includes(b.status));
        if (!active.length) return result;
        const dates = active.map(b => b.eventDate).sort();
        const others = await all(
            `SELECT * FROM bookings WHERE event_date BETWEEN ? AND ? AND status IN ('pending', 'approved')
             ORDER BY event_date, registration_time`, dates[0], dates[dates.length - 1]);
        const byDate = new Map();
        for (const other of others) {
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

    async function countPending(today) {
        const row = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'pending' AND event_date >= ?").bind(today).first();
        return row ? row.n : 0;
    }

    return {
        get,
        create,
        setStatus,
        list,
        findConflicts,
        conflictsFor,
        countPending,
        activeOnDate: (date) => all(
            "SELECT * FROM bookings WHERE event_date = ? AND status IN ('pending', 'approved') ORDER BY registration_time", date),
        withUploadBefore: (date) => all('SELECT * FROM bookings WHERE upload_key IS NOT NULL AND event_date < ?', date),
        clearUpload: (id) => db.prepare('UPDATE bookings SET upload_key = NULL WHERE id = ?').bind(id).run(),
        isUploadUsed: async (key) => Boolean(await db.prepare('SELECT 1 AS x FROM bookings WHERE upload_key = ?').bind(key).first()),
        uploadKeys: async () => new Set((await db.prepare('SELECT upload_key FROM bookings WHERE upload_key IS NOT NULL').all()).results.map(r => r.upload_key)),
        // Counts an upload toward the day's total in one step. Returns false,
        // and counts nothing, if it would go over the cap.
        reserveUpload: async (day, bytes, cap) => Boolean(await db.prepare(
            `INSERT INTO upload_log (day, bytes) SELECT ?1, ?2 WHERE ?2 <= ?3
             ON CONFLICT (day) DO UPDATE SET bytes = bytes + ?2 WHERE bytes + ?2 <= ?3
             RETURNING bytes`).bind(day, bytes, cap).first()),
        clearUploadLog: (beforeDay) => db.prepare('DELETE FROM upload_log WHERE day < ?').bind(beforeDay).run()
    };
}
