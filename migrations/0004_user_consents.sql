CREATE TABLE IF NOT EXISTS user_consents (
  user_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('web', 'android', 'ios')),
  PRIMARY KEY (user_id, policy_version)
);

CREATE INDEX IF NOT EXISTS user_consents_consented_at_idx
  ON user_consents (consented_at);
