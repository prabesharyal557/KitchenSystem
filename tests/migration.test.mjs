import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const migration = (name) =>
  readFileSync(join(root, "migrations", name), "utf8");

test("cancellation migration preserves orders, items, foreign keys, and indexes", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(migration("0001_initial_pos_schema.sql"));
  db.exec(migration("0002_offline_mutations.sql"));
  db.exec(migration("0003_normalized_restaurant_tables.sql"));
  db.exec(migration("0004_user_consents.sql"));

  db.prepare(
    `INSERT INTO orders
      (id, table_number, status, created_at, paid, served_at, served_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "order-before-migration",
    4,
    "ready",
    "2026-09-28T00:00:00Z",
    0,
    null,
    null,
  );
  db.prepare(
    `INSERT INTO order_items
      (order_id, line_number, menu_item_id, item_name, price, cost, quantity)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("order-before-migration", 0, "momo", "Chicken Momo", 180, 100, 2);

  db.exec("BEGIN");
  db.exec(migration("0005_allow_cancelled_orders.sql"));
  db.exec("COMMIT");

  assert.deepEqual(
    {
      ...db
        .prepare("SELECT * FROM orders WHERE id = ?")
        .get("order-before-migration"),
    },
    {
      id: "order-before-migration",
      table_number: 4,
      status: "ready",
      created_at: "2026-09-28T00:00:00Z",
      paid: 0,
      served_at: null,
      served_by_user_id: null,
    },
  );
  assert.equal(
    db
      .prepare("SELECT quantity FROM order_items WHERE order_id = ?")
      .get("order-before-migration").quantity,
    2,
  );

  db.prepare(
    `INSERT INTO orders
      (id, table_number, status, created_at, paid, served_at, served_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "cancelled-order",
    5,
    "cancelled",
    "2026-09-28T00:01:00Z",
    0,
    null,
    null,
  );
  assert.equal(
    db.prepare("SELECT status FROM orders WHERE id = ?").get("cancelled-order")
      .status,
    "cancelled",
  );

  assert.throws(() => {
    db.prepare(
      `INSERT INTO order_items
        (order_id, line_number, menu_item_id, item_name, price, cost, quantity)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("missing-order", 0, "momo", "Momo", 100, 50, 1);
  }, /FOREIGN KEY constraint failed/);

  const indexes = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => row.name),
  );
  assert.ok(indexes.has("orders_table_paid_status_idx"));
  assert.ok(indexes.has("orders_created_at_idx"));
  assert.ok(indexes.has("order_items_menu_item_idx"));
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);

  db.exec("BEGIN");
  db.exec(migration("0006_reliability_and_audit.sql"));
  db.exec("COMMIT");
  const migrated = db
    .prepare("SELECT version, updated_at FROM orders WHERE id = ?")
    .get("order-before-migration");
  assert.equal(migrated.version, 1);
  assert.equal(migrated.updated_at, null);
  assert.equal(
    db.prepare("SELECT version FROM state_versions WHERE id = 1").get().version,
    1,
  );
  assert.doesNotThrow(() =>
    db
      .prepare(
        "INSERT INTO audit_events (id, created_at, actor_username, actor_role, action, entity_type) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "audit-1",
        "2026-09-28T00:02:00Z",
        "manager",
        "manager",
        "order.cancel",
        "order",
      ),
  );
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO order_payments (id, table_number, subtotal, cost, tax_rate, tax, total, method, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "bad-payment",
          1,
          1,
          1,
          0,
          0,
          1,
          "Cash",
          "2026-09-28T00:03:00Z",
          "deleted",
        ),
    /CHECK constraint failed/,
  );
  db.prepare(
    "INSERT INTO users (id, name, username, role, salary, active, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "manager-before-rotation",
    "Manager",
    "manager",
    "manager",
    0,
    1,
    "2026-01-01T00:00:00Z",
  );
  db.exec("BEGIN");
  db.exec(migration("0007_force_manager_password_rotation.sql"));
  db.exec("COMMIT");
  assert.equal(
    db
      .prepare("SELECT must_change_password FROM users WHERE id = ?")
      .get("manager-before-rotation").must_change_password,
    1,
  );
  db.close();
});
