-- Structured restaurant records. The legacy state row remains during the
-- compatibility period, while the Worker writes both forms atomically.
CREATE TABLE IF NOT EXISTS restaurant_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  is_open INTEGER NOT NULL CHECK (is_open IN (0, 1)),
  tax_rate REAL NOT NULL CHECK (tax_rate >= 0 AND tax_rate <= 100)
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  table_number INTEGER PRIMARY KEY,
  seats INTEGER NOT NULL CHECK (seats > 0),
  status TEXT NOT NULL CHECK (status IN ('available', 'busy', 'pending'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('manager', 'waiter', 'kitchen')),
  salary REAL NOT NULL DEFAULT 0 CHECK (salary >= 0),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  joined_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price REAL NOT NULL CHECK (price >= 0),
  cost REAL NOT NULL CHECK (cost >= 0),
  available INTEGER NOT NULL CHECK (available IN (0, 1)),
  sort_rank INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  table_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('new', 'preparing', 'ready', 'served')),
  created_at TEXT NOT NULL,
  paid INTEGER NOT NULL CHECK (paid IN (0, 1)),
  served_at TEXT,
  served_by_user_id TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  menu_item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  price REAL NOT NULL,
  cost REAL NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_id, line_number),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS order_payments (
  id TEXT PRIMARY KEY,
  table_number INTEGER NOT NULL,
  subtotal REAL NOT NULL,
  cost REAL NOT NULL,
  tax_rate REAL NOT NULL,
  tax REAL NOT NULL,
  total REAL NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('Cash', 'QR', 'Card')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_payment_items (
  payment_id TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  menu_item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  price REAL NOT NULL,
  cost REAL NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (payment_id, line_number),
  FOREIGN KEY (payment_id) REFERENCES order_payments(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS staff_payments (
  id TEXT PRIMARY KEY,
  staff_user_id TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  salary_month TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('Salary', 'Advance')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS normalized_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS restaurant_tables_status_idx ON restaurant_tables(status);
CREATE INDEX IF NOT EXISTS menu_items_category_rank_idx ON menu_items(category, sort_rank);
CREATE INDEX IF NOT EXISTS orders_table_paid_status_idx ON orders(table_number, paid, status);
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at);
CREATE INDEX IF NOT EXISTS order_items_menu_item_idx ON order_items(menu_item_id);
CREATE INDEX IF NOT EXISTS order_payments_created_at_idx ON order_payments(created_at);
CREATE INDEX IF NOT EXISTS staff_payments_user_month_idx ON staff_payments(staff_user_id, salary_month);
