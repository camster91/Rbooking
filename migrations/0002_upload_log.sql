-- Bytes uploaded per day (Toronto date), for the daily upload cap.
CREATE TABLE upload_log (
    day TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL
);
