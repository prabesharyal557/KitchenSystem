-- Add reliability metadata without changing or deleting existing records.
ALTER TABLE orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE orders ADD COLUMN updated_at TEXT;
ALTER TABLE orders ADD COLUMN cancellation_reason TEXT;
ALTER TABLE orders ADD COLUMN cancelled_at TEXT;
ALTER TABLE orders ADD COLUMN cancelled_by_user_id TEXT;

ALTER TABLE order_payments ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'
  CHECK (status IN ('completed', 'voided', 'refunded'));
ALTER TABLE order_payments ADD COLUMN corrected_at TEXT;
ALTER TABLE order_payments ADD COLUMN correction_reason TEXT;
ALTER TABLE order_payments ADD COLUMN corrected_by_user_id TEXT;

ALTER TABLE staff_payments ADD COLUMN base_salary REAL;
ALTER TABLE staff_payments ADD COLUMN adjustment REAL NOT NULL DEFAULT 0;
ALTER TABLE staff_payments ADD COLUMN remaining_after REAL;

ALTER TABLE sessions ADD COLUMN created_at INTEGER;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;

CREATE TABLE payment_orders (
  payment_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  PRIMARY KEY (payment_id, order_id),
  FOREIGN KEY (payment_id) REFERENCES order_payments(id) ON DELETE RESTRICT,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  actor_staff_id TEXT,
  actor_username TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  reason TEXT,
  before_value TEXT,
  after_value TEXT,
  session_id TEXT,
  request_id TEXT
);

CREATE TABLE state_versions (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO state_versions (id, version, updated_at)
VALUES (1, 1, CURRENT_TIMESTAMP);

CREATE TABLE login_attempts (
  attempt_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX orders_active_table_idx
  ON orders(table_number, status, paid, updated_at);
CREATE INDEX order_payments_status_created_idx
  ON order_payments(status, created_at);
CREATE INDEX payment_orders_order_idx
  ON payment_orders(order_id);
CREATE INDEX audit_events_created_idx
  ON audit_events(created_at DESC);
CREATE INDEX audit_events_entity_idx
  ON audit_events(entity_type, entity_id, created_at DESC);
CREATE INDEX sessions_staff_last_seen_idx
  ON sessions(staffId, last_seen_at);
