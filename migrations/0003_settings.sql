-- Settings staff change on the admin page. Anything not stored here falls
-- back to the vars in wrangler.jsonc and the Cloudflare secrets.
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
