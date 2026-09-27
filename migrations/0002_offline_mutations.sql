CREATE TABLE IF NOT EXISTS mutations (
  id TEXT PRIMARY KEY,
  staffId TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS mutations_createdAt_idx
  ON mutations(createdAt);
