-- Existing manager credentials predate the strong-password policy.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0
  CHECK (must_change_password IN (0, 1));
UPDATE users SET must_change_password = 1 WHERE role = 'manager';
