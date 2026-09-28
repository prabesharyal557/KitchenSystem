import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "..");
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys=ON");
for (const name of [
  "0001_initial_pos_schema.sql",
  "0002_offline_mutations.sql",
  "0003_normalized_restaurant_tables.sql",
  "0004_user_consents.sql",
  "0005_allow_cancelled_orders.sql",
  "0006_reliability_and_audit.sql",
])
  db.exec(readFileSync(resolve(root, "migrations", name), "utf8"));

db.exec("BEGIN");
db.prepare(
  "INSERT INTO restaurant_settings (id, name, is_open, tax_rate) VALUES (1, 'Benchmark', 1, 13)",
).run();
const order = db.prepare(
  "INSERT INTO orders (id, table_number, status, created_at, paid, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
);
const item = db.prepare(
  "INSERT INTO order_items (order_id, line_number, menu_item_id, item_name, price, cost, quantity) VALUES (?, 0, 'momo', 'Momo', 200, 100, 1)",
);
const payment = db.prepare(
  "INSERT INTO order_payments (id, table_number, subtotal, cost, tax_rate, tax, total, method, created_at) VALUES (?, ?, 200, 100, 13, 26, 226, 'Cash', ?)",
);
for (let index = 0; index < 10000; index++) {
  const createdAt = new Date(
    Date.UTC(2026, 0, 1) + index * 60000,
  ).toISOString();
  const orderId = `order-${index}`;
  order.run(
    orderId,
    (index % 20) + 1,
    index % 5 === 0 ? "new" : "served",
    createdAt,
    index % 5 === 0 ? 0 : 1,
    createdAt,
  );
  item.run(orderId);
  if (index % 5 !== 0)
    payment.run(`payment-${index}`, (index % 20) + 1, createdAt);
}
db.exec("COMMIT");

function time(statement, repetitions = 500) {
  const start = performance.now();
  for (let index = 0; index < repetitions; index++) statement.all();
  return (performance.now() - start) / repetitions;
}
const activeIndexed = db.prepare(
  "SELECT id, status FROM orders WHERE table_number=7 AND status IN ('new','preparing','ready','served') AND paid=0 ORDER BY updated_at",
);
const activeScan = db.prepare(
  "SELECT id, status FROM orders NOT INDEXED WHERE table_number=7 AND status IN ('new','preparing','ready','served') AND paid=0 ORDER BY updated_at",
);
const salesIndexed = db.prepare(
  "SELECT SUM(total), COUNT(*) FROM order_payments WHERE status='completed' AND created_at >= '2026-01-03' AND created_at < '2026-01-07'",
);
const salesScan = db.prepare(
  "SELECT SUM(total), COUNT(*) FROM order_payments NOT INDEXED WHERE status='completed' AND created_at >= '2026-01-03' AND created_at < '2026-01-07'",
);

const incrementalStart = performance.now();
db.exec("BEGIN");
db.prepare(
  "UPDATE orders SET status='ready', version=version+1 WHERE id='order-5'",
).run();
db.exec("ROLLBACK");
const incrementalMs = performance.now() - incrementalStart;

db.exec(
  "CREATE TEMP TABLE orders_copy AS SELECT * FROM orders; CREATE TEMP TABLE items_copy AS SELECT * FROM order_items",
);
const rewriteStart = performance.now();
db.exec(
  "BEGIN; DELETE FROM order_items; DELETE FROM orders; INSERT INTO orders SELECT * FROM orders_copy; INSERT INTO order_items SELECT * FROM items_copy; ROLLBACK",
);
const rewriteMs = performance.now() - rewriteStart;

const result = {
  rows: { orders: 10000, payments: 8000 },
  activeOrderQueryMs: {
    indexed: time(activeIndexed),
    fullScan: time(activeScan),
  },
  salesRangeQueryMs: { indexed: time(salesIndexed), fullScan: time(salesScan) },
  mutationMs: { oneRowIncremental: incrementalMs, fullOrderRewrite: rewriteMs },
  plans: {
    active: db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM orders WHERE table_number=7 AND status IN ('new','preparing','ready','served') AND paid=0 ORDER BY updated_at",
      )
      .all(),
    sales: db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT SUM(total) FROM order_payments WHERE status='completed' AND created_at >= '2026-01-03' AND created_at < '2026-01-07'",
      )
      .all(),
  },
};
mkdirSync(resolve(root, "audit-results"), { recursive: true });
writeFileSync(
  resolve(root, "audit-results", "database-benchmark.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
db.close();
