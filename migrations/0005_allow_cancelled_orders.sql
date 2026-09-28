-- Preserve all order and line data while extending the order state machine.
-- Rebuilding both tables avoids redirecting the order_items foreign key to a
-- temporary/old table during SQLite table renames.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE orders_next (
  id TEXT PRIMARY KEY,
  table_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('new', 'preparing', 'ready', 'served', 'cancelled')),
  created_at TEXT NOT NULL,
  paid INTEGER NOT NULL CHECK (paid IN (0, 1)),
  served_at TEXT,
  served_by_user_id TEXT
);

CREATE TABLE order_items_next (
  order_id TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  menu_item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  price REAL NOT NULL,
  cost REAL NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_id, line_number),
  FOREIGN KEY (order_id) REFERENCES orders_next(id) ON DELETE CASCADE
);

INSERT INTO orders_next (
  id, table_number, status, created_at, paid, served_at, served_by_user_id
)
SELECT id, table_number, status, created_at, paid, served_at, served_by_user_id
FROM orders;

INSERT INTO order_items_next (
  order_id, line_number, menu_item_id, item_name, price, cost, quantity
)
SELECT order_id, line_number, menu_item_id, item_name, price, cost, quantity
FROM order_items;

DROP TABLE order_items;
DROP TABLE orders;
ALTER TABLE orders_next RENAME TO orders;
ALTER TABLE order_items_next RENAME TO order_items;

CREATE INDEX orders_table_paid_status_idx
  ON orders(table_number, paid, status);
CREATE INDEX orders_created_at_idx
  ON orders(created_at);
CREATE INDEX order_items_menu_item_idx
  ON order_items(menu_item_id);
