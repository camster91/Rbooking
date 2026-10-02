-- Bookings. space_group lets the clash check work in SQL: spaces in the same
-- group (all Event Hall set-ups) can't be booked at overlapping times.
CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    status_note TEXT,
    sequence INTEGER NOT NULL DEFAULT 0,
    event_name TEXT NOT NULL,
    event_space TEXT NOT NULL,
    space_group TEXT NOT NULL,
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
    upload_key TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS bookings_date ON bookings (event_date, status);
CREATE INDEX IF NOT EXISTS bookings_clash ON bookings (event_date, space_group, status);
CREATE INDEX IF NOT EXISTS bookings_upload ON bookings (upload_key) WHERE upload_key IS NOT NULL;
