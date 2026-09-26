-- Mirrors the current SQLite database without changing IDs or application concepts.
CREATE TABLE IF NOT EXISTS state (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  staffId TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_staffId_expires_idx
  ON sessions(staffId, expires);

CREATE INDEX IF NOT EXISTS sessions_expires_idx
  ON sessions(expires);
