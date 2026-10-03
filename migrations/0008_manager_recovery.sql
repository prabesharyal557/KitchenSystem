CREATE TABLE IF NOT EXISTS manager_recovery (
  staff_id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  expires INTEGER NOT NULL,
  FOREIGN KEY (staff_id) REFERENCES users(id)
);
