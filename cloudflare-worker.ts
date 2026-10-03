import { cancelTickets, CancellationError } from "./cancellation.ts";
import {
  recoverManager,
  verifyManagerRecoveryCode,
} from "./manager-recovery.ts";
import { DurableObject } from "cloudflare:workers";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { calculateBill, roundMoney } from "./domain";

type Role = "manager" | "waiter" | "kitchen";
type Staff = {
  id: string;
  name: string;
  username: string;
  role: Role;
  salary: number;
  active: boolean;
  joined: string;
  mustChangePassword?: boolean;
};
type Item = {
  id: string;
  name: string;
  category: string;
  price: number;
  cost: number;
  available: boolean;
  rank: number;
};
type Line = {
  id: string;
  name: string;
  price: number;
  cost: number;
  qty: number;
};
type Order = {
  id: string;
  table: number;
  status: string;
  items: Line[];
  createdAt: string;
  paid: boolean;
  servedAt?: string;
  servedById?: string;
  version: number;
  updatedAt: string;
  cancellationReason?: string;
  cancelledAt?: string;
  cancelledById?: string;
};
type Sale = {
  id: string;
  table: number;
  items: Line[];
  subtotal: number;
  cost: number;
  taxRate: number;
  tax: number;
  total: number;
  method: string;
  createdAt: string;
  status: "completed" | "voided" | "refunded";
  correctedAt?: string;
  correctionReason?: string;
  correctedById?: string;
  orderIds: string[];
};
type State = {
  settings: { name: string; open: boolean; taxRate: number };
  tables: { n: number; seats: number; status: string }[];
  menu: Item[];
  orders: Order[];
  sales: Sale[];
  staff: Staff[];
  payments: {
    id: string;
    staffId: string;
    amount: number;
    month: string;
    kind: string;
    note: string;
    createdAt: string;
    baseSalary: number;
    adjustment: number;
    remainingAfter: number;
  }[];
  stateVersion?: number;
  updatedAt?: string;
};
type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  RESTAURANT_COORDINATOR: DurableObjectNamespace<RestaurantCoordinator>;
};
type Effects = { credentials: Map<string, string>; revoke: Set<string> };

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const SESSION_MILLISECONDS = SESSION_SECONDS * 1000;

const id = () => randomBytes(12).toString("hex");
const now = () => new Date().toISOString();
const round = roundMoney;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function requireThat(
  condition: unknown,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new HttpError(status, message);
}
function text(value: unknown, label: string, max = 100) {
  requireThat(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.trim().length <= max,
    `${label} is required (maximum ${max} characters).`,
  );
  return value.trim();
}
function num(value: unknown, label: string, min = 0, max = 10_000_000) {
  requireThat(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max,
    `${label} must be between ${min} and ${max}.`,
  );
  return round(value);
}
function bool(value: unknown) {
  requireThat(typeof value === "boolean", "Expected a true or false value.");
  return value;
}
function password(value: unknown) {
  requireThat(
    typeof value === "string" && value.length >= 12 && value.length <= 128,
    "Use a password with 12–128 characters.",
  );
  return value;
}
function username(value: unknown) {
  const name = text(value, "Username", 40).toLowerCase();
  requireThat(
    /^[a-z0-9._-]+$/.test(name),
    "Use letters, numbers, dots, hyphens or underscores in usernames.",
  );
  return name;
}
function makeHash(value: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(value, salt, 64).toString("hex")}`;
}
function matches(value: string, stored: string) {
  const [salt, key] = stored.split(":");
  if (!salt || !key || !/^[a-f0-9]{128}$/i.test(key)) return false;
  return timingSafeEqual(scryptSync(value, salt, 64), Buffer.from(key, "hex"));
}

function cookieName(request: Request) {
  const scope = request.headers.get("X-Sajilo-Session");
  if (scope === null) return "sajilo";
  requireThat(/^[a-f0-9]{32}$/.test(scope), "Invalid session selector.");
  return `sajilo_${scope}`;
}
function sessionToken(request: Request) {
  const name = cookieName(request).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(
      request.headers.get("Cookie") || "",
    )?.[1] || ""
  );
}
function cookie(request: Request, value: string, maxAge: number) {
  const crossOrigin = [
    "capacitor://localhost",
    "http://localhost",
    "https://localhost",
  ].includes(request.headers.get("Origin") || "");
  return `${cookieName(request)}=${value}; HttpOnly; ${crossOrigin ? "SameSite=None; " : "SameSite=Strict; "}Secure; Path=/; Max-Age=${maxAge}`;
}
async function parseBody(request: Request) {
  const declared = Number(request.headers.get("Content-Length") || "0");
  requireThat(
    Number.isFinite(declared) && declared < 65_536,
    "Request too large.",
    413,
  );
  const raw = await request.text();
  requireThat(Buffer.byteLength(raw) < 65_536, "Request too large.", 413);
  let value: unknown;
  try {
    value = JSON.parse(raw || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
  requireThat(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected a JSON object.",
  );
  return value as Record<string, any>;
}
function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}
function snapshot(state: State, user: Staff) {
  if (user.role === "manager") return { ...state, user };
  if (user.role === "kitchen")
    return {
      settings: state.settings,
      stateVersion: state.stateVersion,
      updatedAt: state.updatedAt,
      orders: state.orders
        .filter(
          (order) =>
            !order.paid &&
            ["new", "preparing", "ready", "cancelled"].includes(order.status),
        )
        .map((order) => ({
          ...order,
          items: order.items.map(({ cost, price, ...item }) => item),
        })),
      user,
    };
  return {
    settings: state.settings,
    stateVersion: state.stateVersion,
    updatedAt: state.updatedAt,
    tables: state.tables,
    menu: state.menu.map(({ cost, ...item }) => item),
    orders: state.orders.map((order) => ({
      ...order,
      items: order.items.map(({ cost, ...item }) => item),
    })),
    user,
  };
}

function normalizedStatements(database: D1Database, state: State) {
  const tables = JSON.stringify(state.tables);
  const users = JSON.stringify(state.staff);
  const menu = JSON.stringify(state.menu);
  const orders = JSON.stringify(state.orders);
  const orderPayments = JSON.stringify(state.sales);
  const staffPayments = JSON.stringify(state.payments);
  return [
    database.prepare("DELETE FROM order_items"),
    database.prepare("DELETE FROM order_payment_items"),
    database.prepare("DELETE FROM orders"),
    database.prepare("DELETE FROM order_payments"),
    database.prepare("DELETE FROM staff_payments"),
    database.prepare("DELETE FROM menu_items"),
    database.prepare("DELETE FROM restaurant_tables"),
    database.prepare("DELETE FROM users"),
    database.prepare("DELETE FROM restaurant_settings"),
    database
      .prepare(
        "INSERT INTO restaurant_settings (id, name, is_open, tax_rate) VALUES (1, ?, ?, ?)",
      )
      .bind(
        state.settings.name,
        state.settings.open ? 1 : 0,
        state.settings.taxRate,
      ),
    database
      .prepare(
        `INSERT INTO restaurant_tables (table_number, seats, status)
      SELECT json_extract(value, '$.n'), json_extract(value, '$.seats'), json_extract(value, '$.status') FROM json_each(?)`,
      )
      .bind(tables),
    database
      .prepare(
        `INSERT INTO users (id, name, username, role, salary, active, joined_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.username'), json_extract(value, '$.role'), json_extract(value, '$.salary'), json_extract(value, '$.active'), json_extract(value, '$.joined') FROM json_each(?)`,
      )
      .bind(users),
    database
      .prepare(
        `INSERT INTO menu_items (id, name, category, price, cost, available, sort_rank)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.category'), json_extract(value, '$.price'), json_extract(value, '$.cost'), json_extract(value, '$.available'), json_extract(value, '$.rank') FROM json_each(?)`,
      )
      .bind(menu),
    database
      .prepare(
        `INSERT INTO orders (id, table_number, status, created_at, paid, served_at, served_by_user_id)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.table'), json_extract(value, '$.status'), json_extract(value, '$.createdAt'), json_extract(value, '$.paid'), json_extract(value, '$.servedAt'), json_extract(value, '$.servedById') FROM json_each(?)`,
      )
      .bind(orders),
    database
      .prepare(
        `INSERT INTO order_items (order_id, line_number, menu_item_id, item_name, price, cost, quantity)
      SELECT json_extract(parent.value, '$.id'), CAST(line.key AS INTEGER), json_extract(line.value, '$.id'), json_extract(line.value, '$.name'), json_extract(line.value, '$.price'), json_extract(line.value, '$.cost'), json_extract(line.value, '$.qty') FROM json_each(?) parent JOIN json_each(parent.value, '$.items') line`,
      )
      .bind(orders),
    database
      .prepare(
        `INSERT INTO order_payments (id, table_number, subtotal, cost, tax_rate, tax, total, method, created_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.table'), json_extract(value, '$.subtotal'), json_extract(value, '$.cost'), json_extract(value, '$.taxRate'), json_extract(value, '$.tax'), json_extract(value, '$.total'), json_extract(value, '$.method'), json_extract(value, '$.createdAt') FROM json_each(?)`,
      )
      .bind(orderPayments),
    database
      .prepare(
        `INSERT INTO order_payment_items (payment_id, line_number, menu_item_id, item_name, price, cost, quantity)
      SELECT json_extract(parent.value, '$.id'), CAST(line.key AS INTEGER), json_extract(line.value, '$.id'), json_extract(line.value, '$.name'), json_extract(line.value, '$.price'), json_extract(line.value, '$.cost'), json_extract(line.value, '$.qty') FROM json_each(?) parent JOIN json_each(parent.value, '$.items') line`,
      )
      .bind(orderPayments),
    database
      .prepare(
        `INSERT INTO staff_payments (id, staff_user_id, amount, salary_month, kind, note, created_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.staffId'), json_extract(value, '$.amount'), json_extract(value, '$.month'), json_extract(value, '$.kind'), json_extract(value, '$.note'), json_extract(value, '$.createdAt') FROM json_each(?)`,
      )
      .bind(staffPayments),
    database
      .prepare(
        "INSERT INTO normalized_meta (key, value) VALUES ('state_synced_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .bind(now()),
  ];
}

const rows = <T>(result: D1Result<unknown>) => result.results as T[];

async function normalizedState(database: D1Database): Promise<State> {
  const results = await database.batch([
    database.prepare(
      "SELECT name, is_open, tax_rate FROM restaurant_settings WHERE id = 1",
    ),
    database.prepare(
      "SELECT table_number, seats, status FROM restaurant_tables ORDER BY table_number",
    ),
    database.prepare(
      "SELECT id, name, username, role, salary, active, joined_at, must_change_password FROM users ORDER BY joined_at, id",
    ),
    database.prepare(
      "SELECT id, name, category, price, cost, available, sort_rank FROM menu_items ORDER BY sort_rank, name",
    ),
    database.prepare(
      "SELECT id, table_number, status, created_at, paid, served_at, served_by_user_id, version, updated_at, cancellation_reason, cancelled_at, cancelled_by_user_id FROM orders ORDER BY created_at DESC",
    ),
    database.prepare(
      "SELECT order_id, menu_item_id, item_name, price, cost, quantity FROM order_items ORDER BY order_id, line_number",
    ),
    database.prepare(
      "SELECT id, table_number, subtotal, cost, tax_rate, tax, total, method, created_at, status, corrected_at, correction_reason, corrected_by_user_id FROM order_payments ORDER BY created_at DESC",
    ),
    database.prepare(
      "SELECT payment_id, menu_item_id, item_name, price, cost, quantity FROM order_payment_items ORDER BY payment_id, line_number",
    ),
    database.prepare(
      "SELECT id, staff_user_id, amount, salary_month, kind, note, created_at, base_salary, adjustment, remaining_after FROM staff_payments ORDER BY created_at DESC",
    ),
    database.prepare(
      "SELECT payment_id, order_id FROM payment_orders ORDER BY payment_id, order_id",
    ),
    database.prepare(
      "SELECT version, updated_at FROM state_versions WHERE id = 1",
    ),
  ]);
  const setting = rows<any>(results[0])[0];
  requireThat(setting, "Restaurant database is not initialized.", 503);
  const orderLines = rows<any>(results[5]);
  const paymentLines = rows<any>(results[7]);
  const links = rows<any>(results[9]);
  const version = rows<any>(results[10])[0] || {
    version: 1,
    updated_at: now(),
  };
  return {
    settings: {
      name: setting.name,
      open: Boolean(setting.is_open),
      taxRate: setting.tax_rate,
    },
    tables: rows<any>(results[1]).map((row) => ({
      n: row.table_number,
      seats: row.seats,
      status: row.status,
    })),
    staff: rows<any>(results[2]).map((row) => ({
      id: row.id,
      name: row.name,
      username: row.username,
      role: row.role,
      salary: row.salary,
      active: Boolean(row.active),
      joined: row.joined_at,
      mustChangePassword: Boolean(row.must_change_password),
    })),
    menu: rows<any>(results[3]).map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category,
      price: row.price,
      cost: row.cost,
      available: Boolean(row.available),
      rank: row.sort_rank,
    })),
    orders: rows<any>(results[4]).map((row) => ({
      id: row.id,
      table: row.table_number,
      status: row.status,
      createdAt: row.created_at,
      paid: Boolean(row.paid),
      servedAt: row.served_at || undefined,
      servedById: row.served_by_user_id || undefined,
      version: row.version || 1,
      updatedAt: row.updated_at || row.created_at,
      cancellationReason: row.cancellation_reason || undefined,
      cancelledAt: row.cancelled_at || undefined,
      cancelledById: row.cancelled_by_user_id || undefined,
      items: orderLines
        .filter((line) => line.order_id === row.id)
        .map((line) => ({
          id: line.menu_item_id,
          name: line.item_name,
          price: line.price,
          cost: line.cost,
          qty: line.quantity,
        })),
    })),
    sales: rows<any>(results[6]).map((row) => ({
      id: row.id,
      table: row.table_number,
      subtotal: row.subtotal,
      cost: row.cost,
      taxRate: row.tax_rate,
      tax: row.tax,
      total: row.total,
      method: row.method,
      createdAt: row.created_at,
      status: row.status || "completed",
      correctedAt: row.corrected_at || undefined,
      correctionReason: row.correction_reason || undefined,
      correctedById: row.corrected_by_user_id || undefined,
      orderIds: links
        .filter((link) => link.payment_id === row.id)
        .map((link) => link.order_id),
      items: paymentLines
        .filter((line) => line.payment_id === row.id)
        .map((line) => ({
          id: line.menu_item_id,
          name: line.item_name,
          price: line.price,
          cost: line.cost,
          qty: line.quantity,
        })),
    })),
    payments: rows<any>(results[8]).map((row) => ({
      id: row.id,
      staffId: row.staff_user_id,
      amount: row.amount,
      month: row.salary_month,
      kind: row.kind,
      note: row.note,
      createdAt: row.created_at,
      baseSalary: row.base_salary ?? 0,
      adjustment: row.adjustment ?? 0,
      remainingAfter: row.remaining_after ?? 0,
    })),
    stateVersion: version.version,
    updatedAt: version.updated_at,
  };
}

function changed<T extends { id: string }>(before: T[], after: T[]) {
  const previous = new Map(before.map((entry) => [entry.id, entry]));
  return after.filter(
    (entry) => JSON.stringify(previous.get(entry.id)) !== JSON.stringify(entry),
  );
}

function incrementalStatements(
  database: D1Database,
  before: State,
  after: State,
  action: string,
  payload: any,
) {
  const statements: D1PreparedStatement[] = [];
  if (JSON.stringify(before.settings) !== JSON.stringify(after.settings))
    statements.push(
      database
        .prepare(
          "UPDATE restaurant_settings SET name = ?, is_open = ?, tax_rate = ? WHERE id = 1",
        )
        .bind(
          after.settings.name,
          after.settings.open ? 1 : 0,
          after.settings.taxRate,
        ),
    );

  const tableMap = new Map(before.tables.map((entry) => [entry.n, entry]));
  for (const table of after.tables)
    if (JSON.stringify(tableMap.get(table.n)) !== JSON.stringify(table))
      statements.push(
        database
          .prepare(
            "INSERT INTO restaurant_tables (table_number, seats, status) VALUES (?, ?, ?) ON CONFLICT(table_number) DO UPDATE SET seats = excluded.seats, status = excluded.status",
          )
          .bind(table.n, table.seats, table.status),
      );
  for (const table of before.tables)
    if (!after.tables.some((entry) => entry.n === table.n))
      statements.push(
        database
          .prepare("DELETE FROM restaurant_tables WHERE table_number = ?")
          .bind(table.n),
      );

  for (const user of changed(before.staff, after.staff))
    statements.push(
      database
        .prepare(
          "INSERT INTO users (id, name, username, role, salary, active, joined_at, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, username = excluded.username, role = excluded.role, salary = excluded.salary, active = excluded.active, must_change_password = excluded.must_change_password",
        )
        .bind(
          user.id,
          user.name,
          user.username,
          user.role,
          user.salary,
          user.active ? 1 : 0,
          user.joined,
          user.mustChangePassword ? 1 : 0,
        ),
    );

  for (const item of changed(before.menu, after.menu))
    statements.push(
      database
        .prepare(
          "INSERT INTO menu_items (id, name, category, price, cost, available, sort_rank) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category, price = excluded.price, cost = excluded.cost, available = excluded.available, sort_rank = excluded.sort_rank",
        )
        .bind(
          item.id,
          item.name,
          item.category,
          item.price,
          item.cost,
          item.available ? 1 : 0,
          item.rank,
        ),
    );
  for (const item of before.menu)
    if (!after.menu.some((entry) => entry.id === item.id))
      statements.push(
        database.prepare("DELETE FROM menu_items WHERE id = ?").bind(item.id),
      );

  for (const order of changed(before.orders, after.orders)) {
    statements.push(
      database
        .prepare(
          `INSERT INTO orders (id, table_number, status, created_at, paid, served_at, served_by_user_id, version, updated_at, cancellation_reason, cancelled_at, cancelled_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET table_number = excluded.table_number, status = excluded.status, paid = excluded.paid, served_at = excluded.served_at, served_by_user_id = excluded.served_by_user_id, version = excluded.version, updated_at = excluded.updated_at, cancellation_reason = excluded.cancellation_reason, cancelled_at = excluded.cancelled_at, cancelled_by_user_id = excluded.cancelled_by_user_id`,
        )
        .bind(
          order.id,
          order.table,
          order.status,
          order.createdAt,
          order.paid ? 1 : 0,
          order.servedAt || null,
          order.servedById || null,
          order.version,
          order.updatedAt,
          order.cancellationReason || null,
          order.cancelledAt || null,
          order.cancelledById || null,
        ),
    );
    const old = before.orders.find((entry) => entry.id === order.id);
    if (!old || JSON.stringify(old.items) !== JSON.stringify(order.items)) {
      statements.push(
        database
          .prepare("DELETE FROM order_items WHERE order_id = ?")
          .bind(order.id),
      );
      order.items.forEach((line, index) =>
        statements.push(
          database
            .prepare(
              "INSERT INTO order_items (order_id, line_number, menu_item_id, item_name, price, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(
              order.id,
              index,
              line.id,
              line.name,
              line.price,
              line.cost,
              line.qty,
            ),
        ),
      );
    }
  }

  for (const sale of changed(before.sales, after.sales)) {
    statements.push(
      database
        .prepare(
          `INSERT INTO order_payments (id, table_number, subtotal, cost, tax_rate, tax, total, method, created_at, status, corrected_at, correction_reason, corrected_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, corrected_at = excluded.corrected_at, correction_reason = excluded.correction_reason, corrected_by_user_id = excluded.corrected_by_user_id`,
        )
        .bind(
          sale.id,
          sale.table,
          sale.subtotal,
          sale.cost,
          sale.taxRate,
          sale.tax,
          sale.total,
          sale.method,
          sale.createdAt,
          sale.status,
          sale.correctedAt || null,
          sale.correctionReason || null,
          sale.correctedById || null,
        ),
    );
    const old = before.sales.find((entry) => entry.id === sale.id);
    if (!old) {
      sale.items.forEach((line, index) =>
        statements.push(
          database
            .prepare(
              "INSERT INTO order_payment_items (payment_id, line_number, menu_item_id, item_name, price, cost, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(
              sale.id,
              index,
              line.id,
              line.name,
              line.price,
              line.cost,
              line.qty,
            ),
        ),
      );
      sale.orderIds.forEach((orderId) =>
        statements.push(
          database
            .prepare(
              "INSERT INTO payment_orders (payment_id, order_id) VALUES (?, ?)",
            )
            .bind(sale.id, orderId),
        ),
      );
    }
  }

  for (const payment of changed(before.payments, after.payments))
    statements.push(
      database
        .prepare(
          "INSERT INTO staff_payments (id, staff_user_id, amount, salary_month, kind, note, created_at, base_salary, adjustment, remaining_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          payment.id,
          payment.staffId,
          payment.amount,
          payment.month,
          payment.kind,
          payment.note,
          payment.createdAt,
          payment.baseSalary,
          payment.adjustment,
          payment.remainingAfter,
        ),
    );

  const updatedAt = now();
  statements.push(
    database
      .prepare(
        "UPDATE state_versions SET version = version + 1, updated_at = ? WHERE id = 1",
      )
      .bind(updatedAt),
  );
  after.stateVersion = (before.stateVersion || 1) + 1;
  after.updatedAt = updatedAt;
  return statements;
}

function manager(user: Staff) {
  requireThat(user.role === "manager", "Manager access required.", 403);
}

function mutate(
  state: State,
  user: Staff,
  action: string,
  payload: any,
  effects: Effects,
) {
  requireThat(
    payload && typeof payload === "object" && !Array.isArray(payload),
    "Expected action parameters.",
  );
  if (action === "order.create") {
    requireThat(
      ["manager", "waiter"].includes(user.role),
      "Waiter access required.",
      403,
    );
    const table = state.tables.find((entry) => entry.n === payload.table);
    requireThat(table, "Table no longer exists.");
    requireThat(
      Array.isArray(payload.items) &&
        payload.items.length > 0 &&
        payload.items.length <= 100,
      "Select 1–100 items.",
    );
    const items = payload.items.map((line: any) => {
      requireThat(line && typeof line === "object", "Invalid order line.");
      const item = state.menu.find(
        (entry) => entry.id === line.id && entry.available,
      );
      requireThat(item, "An item is unavailable. Refresh your order.");
      const quantity = num(line.qty, "Quantity", 1, 100);
      requireThat(
        Number.isInteger(quantity),
        "Quantity must be a whole number.",
      );
      return {
        id: item.id,
        name: item.name,
        price: item.price,
        cost: item.cost,
        qty: quantity,
      };
    });
    const orderId = payload.clientOrderId
      ? text(payload.clientOrderId, "Offline order ID", 40)
      : id();
    requireThat(
      !payload.clientOrderId || /^offline-[a-f0-9]{32}$/.test(orderId),
      "Invalid offline order ID.",
    );
    requireThat(
      !state.orders.some((order) => order.id === orderId),
      "Order already exists.",
      409,
    );
    const createdAt = now();
    state.orders.unshift({
      id: orderId,
      table: table.n,
      status: "new",
      items,
      createdAt,
      paid: false,
      version: 1,
      updatedAt: createdAt,
    });
    table.status = "busy";
    return;
  }
  if (action === "order.advance") {
    requireThat(
      (["manager", "kitchen"].includes(user.role) &&
        payload.status !== "ready") ||
        (user.role === "waiter" && payload.status === "ready"),
      "Only managers or kitchen staff can mark orders ready. Only waiters can mark ready orders served.",
      403,
    );
    const order = state.orders.find(
      (entry) => entry.id === payload.id && !entry.paid,
    );
    requireThat(
      order && ["new", "preparing", "ready"].includes(order.status),
      "Order cannot be advanced.",
    );
    requireThat(
      order.status === payload.status,
      "Order already updated. Refresh and try again.",
      409,
    );
    if (payload.expectedVersion !== undefined)
      requireThat(
        order.version === payload.expectedVersion,
        "This order changed on another device. Refresh before trying again.",
        409,
      );
    order.status = (
      { new: "ready", preparing: "ready", ready: "served" } as Record<
        string,
        string
      >
    )[order.status];
    order.version += 1;
    order.updatedAt = now();
    if (order.status === "served") {
      order.servedAt = now();
      order.servedById = user.id;
    }
    return;
  }
  if (action === "order.cancel") {
    cancelTickets(state, user, payload, id);
    return;
  }
  if (action === "sale.pay") {
    requireThat(
      ["manager", "waiter"].includes(user.role),
      "Waiter access required.",
      403,
    );
    const orders = state.orders.filter(
      (order) =>
        order.table === payload.table &&
        !order.paid &&
        order.status !== "cancelled",
    );
    requireThat(orders.length, "This table has no unpaid orders.");
    requireThat(
      orders.every((order) => order.status === "served"),
      "Mark all orders served before payment.",
    );
    requireThat(
      ["Cash", "QR", "Card"].includes(payload.method),
      "Choose a payment method.",
    );
    const items = orders.flatMap((order) => order.items);
    const { subtotal, cost, tax, total } = calculateBill(
      items,
      state.settings.taxRate,
    );
    requireThat(
      payload.expectedTotal === total,
      "The bill changed. Review the updated bill before collecting payment.",
      409,
    );
    state.sales.unshift({
      id: id(),
      table: payload.table,
      items,
      subtotal,
      cost,
      taxRate: state.settings.taxRate,
      tax,
      total,
      method: payload.method,
      createdAt: now(),
      status: "completed",
      orderIds: orders.map((order) => order.id),
    });
    orders.forEach((order) => {
      order.paid = true;
      order.version += 1;
      order.updatedAt = now();
    });
    const table = state.tables.find((entry) => entry.n === payload.table);
    if (table) table.status = "available";
    return;
  }
  manager(user);
  if (action === "table.add") {
    const number = num(payload.n, "Table number", 1, 999);
    const seats = num(payload.seats, "Seats", 1, 50);
    requireThat(
      Number.isInteger(number) && Number.isInteger(seats),
      "Table and seats must be whole numbers.",
    );
    requireThat(
      !state.tables.some((table) => table.n === number),
      "Table number already exists.",
    );
    state.tables.push({ n: number, seats, status: "available" });
    state.tables.sort((a, b) => a.n - b.n);
  } else if (action === "table.update" || action === "table.delete") {
    const table = state.tables.find((entry) => entry.n === payload.n);
    requireThat(table, "Table not found.");
    const occupied = state.orders.some(
      (order) =>
        order.table === payload.n &&
        !order.paid &&
        order.status !== "cancelled",
    );
    requireThat(
      !occupied || (action === "table.update" && payload.status === "busy"),
      "Settle the outstanding bill before freeing or deleting this table.",
    );
    if (action === "table.delete")
      state.tables = state.tables.filter((entry) => entry.n !== payload.n);
    else {
      requireThat(
        ["available", "busy", "pending"].includes(payload.status),
        "Invalid table status.",
      );
      table.status = payload.status;
    }
  } else if (action === "menu.save") {
    const existing = state.menu.find((item) => item.id === payload.id);
    requireThat(!payload.id || existing, "Menu item not found.");
    const item: Item = {
      id: existing?.id || id(),
      name: text(payload.name, "Item name"),
      category: text(payload.category, "Category"),
      price: num(payload.price, "Price"),
      cost: num(payload.cost, "Ingredient cost"),
      rank: num(payload.rank, "Sort position", 0, 9999),
      available: bool(payload.available),
    };
    if (existing) Object.assign(existing, item);
    else state.menu.push(item);
  } else if (action === "menu.delete") {
    requireThat(
      state.menu.some((item) => item.id === payload.id),
      "Item not found.",
    );
    state.menu = state.menu.filter((item) => item.id !== payload.id);
  } else if (action === "staff.save") {
    const existing = state.staff.find((staff) => staff.id === payload.id);
    const oldRole = existing?.role;
    requireThat(!payload.id || existing, "Staff member not found.");
    const login = username(payload.username);
    requireThat(
      !state.staff.some(
        (staff) => staff.username === login && staff.id !== payload.id,
      ),
      "Username is already taken.",
    );
    requireThat(
      ["manager", "waiter", "kitchen"].includes(payload.role),
      "Invalid role.",
    );
    const active = bool(payload.active);
    requireThat(
      payload.id !== user.id || (active && payload.role === "manager"),
      "You cannot suspend or demote your own account.",
    );
    const member: Staff = {
      id: existing?.id || id(),
      name: text(payload.name, "Name"),
      username: login,
      role: payload.role,
      salary: num(payload.salary, "Monthly salary"),
      active,
      joined: existing?.joined || now(),
      mustChangePassword: Boolean(
        payload.role === "manager" &&
        (existing
          ? payload.password
            ? true
            : existing.mustChangePassword
          : true),
      ),
    };
    if (!existing || payload.password)
      effects.credentials.set(member.id, makeHash(password(payload.password)));
    if (existing) Object.assign(existing, member);
    else state.staff.push(member);
    if (existing && (payload.password || !active || oldRole !== member.role))
      effects.revoke.add(member.id);
  } else if (action === "staff.payment") {
    requireThat(
      state.staff.some((staff) => staff.id === payload.staffId),
      "Staff member not found.",
    );
    requireThat(
      /^\d{4}-(0[1-9]|1[0-2])$/.test(payload.month),
      "Choose a salary month.",
    );
    requireThat(
      ["Salary", "Advance"].includes(payload.kind),
      "Choose salary or advance.",
    );
    const staff = state.staff.find((entry) => entry.id === payload.staffId)!;
    const amount = num(payload.amount, "Payment", 0.01);
    const paidForPeriod = state.payments
      .filter(
        (entry) => entry.staffId === staff.id && entry.month === payload.month,
      )
      .reduce((sum, entry) => sum + entry.amount, 0);
    state.payments.unshift({
      id: id(),
      staffId: payload.staffId,
      amount,
      month: payload.month,
      kind: payload.kind,
      note: typeof payload.note === "string" ? payload.note.slice(0, 300) : "",
      createdAt: now(),
      baseSalary: staff.salary,
      adjustment: 0,
      remainingAfter: round(staff.salary - paidForPeriod - amount),
    });
  } else if (action === "sale.reverse") {
    const sale = state.sales.find((entry) => entry.id === payload.id);
    requireThat(
      sale && sale.status === "completed",
      "Payment is not available for reversal.",
      409,
    );
    const reason = text(payload.reason, "Correction reason", 300);
    requireThat(reason.length >= 3, "Enter a correction reason.");
    sale.status = payload.type === "refund" ? "refunded" : "voided";
    sale.correctedAt = now();
    sale.correctionReason = reason;
    sale.correctedById = user.id;
    for (const order of state.orders.filter((entry) =>
      sale.orderIds.includes(entry.id),
    )) {
      order.paid = false;
      order.version += 1;
      order.updatedAt = sale.correctedAt;
    }
    const table = state.tables.find((entry) => entry.n === sale.table);
    if (table && sale.orderIds.length) table.status = "busy";
  } else if (action === "account.password") {
    effects.credentials.set(user.id, makeHash(password(payload.newPassword)));
    effects.revoke.add(user.id);
    user.mustChangePassword = false;
  } else if (action === "sessions.revoke_all") {
    const staffId = payload.staffId
      ? text(payload.staffId, "Staff ID", 64)
      : user.id;
    requireThat(
      staffId === user.id || user.role === "manager",
      "Manager access required.",
      403,
    );
    requireThat(
      state.staff.some((entry) => entry.id === staffId),
      "Staff member not found.",
    );
    effects.revoke.add(staffId);
  } else if (action === "settings.save") {
    state.settings = {
      name: text(payload.name, "Restaurant name"),
      open: bool(payload.open),
      taxRate: num(payload.taxRate, "Tax rate", 0, 100),
    };
    if (!payload.open)
      state.staff
        .filter((staff) => staff.role !== "manager")
        .forEach((staff) => effects.revoke.add(staff.id));
  } else throw new HttpError(404, "Unknown action.");
}

export class RestaurantCoordinator extends DurableObject<Env> {
  private queue: Promise<void> = Promise.resolve();
  private normalizedReady = false;

  private async ensureNormalized() {
    if (this.normalizedReady) return;
    const marker = await this.env.DB.prepare(
      "SELECT value FROM normalized_meta WHERE key = 'state_synced_at'",
    ).first();
    if (!marker) {
      const row = await this.env.DB.prepare(
        "SELECT body FROM state WHERE id = 1",
      ).first<{ body: string }>();
      requireThat(row, "Restaurant database is not initialized.", 503);
      await this.env.DB.batch(
        normalizedStatements(this.env.DB, JSON.parse(row.body) as State),
      );
    }
    this.normalizedReady = true;
  }

  private async state() {
    await this.ensureNormalized();
    return normalizedState(this.env.DB);
  }

  private async loginLimit(request: Request, login: string) {
    const current = Date.now();
    const key = sha256(
      `${request.headers.get("CF-Connecting-IP") || "unknown"}:${login}`,
    );
    const attempt = await this.env.DB.prepare(
      "SELECT failures, window_started_at, blocked_until FROM login_attempts WHERE attempt_key = ?",
    )
      .bind(key)
      .first<any>();
    requireThat(
      !attempt || attempt.blocked_until <= current,
      "Too many sign-in attempts. Try again in 15 minutes.",
      429,
    );
    return key;
  }

  private async failedLogin(key: string) {
    const current = Date.now();
    const row = await this.env.DB.prepare(
      "SELECT failures, window_started_at FROM login_attempts WHERE attempt_key = ?",
    )
      .bind(key)
      .first<any>();
    const freshWindow = !row || row.window_started_at < current - 900_000;
    const failures = freshWindow ? 1 : row.failures + 1;
    await this.env.DB.prepare(
      `INSERT INTO login_attempts (attempt_key, failures, window_started_at, blocked_until) VALUES (?, ?, ?, ?)
      ON CONFLICT(attempt_key) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at, blocked_until = excluded.blocked_until`,
    )
      .bind(
        key,
        failures,
        freshWindow ? current : row.window_started_at,
        failures >= 10 ? current + 900_000 : 0,
      )
      .run();
  }

  private async account(request: Request, state: State) {
    const token = sha256(sessionToken(request));
    const session = await this.env.DB.prepare(
      "SELECT staffId, last_seen_at FROM sessions WHERE token = ? AND expires > ?",
    )
      .bind(token, Date.now())
      .first<{ staffId: string; last_seen_at: number | null }>();
    const user = state.staff.find(
      (staff) => staff.id === session?.staffId && staff.active,
    );
    requireThat(session && user, "Please sign in.", 401);
    requireThat(
      state.settings.open || user.role === "manager",
      "Restaurant is closed. Staff access is suspended until a manager opens it.",
      403,
    );
    if (!session.last_seen_at || session.last_seen_at < Date.now() - 300_000)
      await this.env.DB.prepare(
        "UPDATE sessions SET last_seen_at = ? WHERE token = ?",
      )
        .bind(Date.now(), token)
        .run();
    return user;
  }

  private async createSession(request: Request, user: Staff) {
    const token = randomBytes(32).toString("hex");
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM sessions WHERE expires <= ?").bind(
        Date.now(),
      ),
      this.env.DB.prepare(
        "INSERT INTO sessions (token, staffId, expires, created_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(
        sha256(token),
        user.id,
        Date.now() + SESSION_MILLISECONDS,
        Date.now(),
        Date.now(),
        request.headers.get("User-Agent")?.slice(0, 300) || "unknown",
      ),
    ]);
    return cookie(request, token, SESSION_SECONDS);
  }

  async fetch(request: Request) {
    const response = this.queue.then(
      () => this.handle(request),
      () => this.handle(request),
    );
    this.queue = response.then(
      () => undefined,
      () => undefined,
    );
    return response;
  }

  private async handle(request: Request) {
    const requestId = request.headers.get("CF-Ray") || id();
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      cookieName(request);
      requireThat(
        ["GET", "POST"].includes(request.method),
        "Method not allowed.",
        405,
      );
      if (request.method === "POST")
        requireThat(
          request.headers.get("Content-Type")?.startsWith("application/json"),
          "JSON content type required.",
          415,
        );
      if (path === "/api/bootstrap" && request.method === "GET")
        return json({ setup: false });
      const payload = request.method === "POST" ? await parseBody(request) : {};
      if (path === "/api/setup" && request.method === "POST")
        throw new HttpError(404, "Manager setup is disabled.");
      if (path === "/api/verify-recovery-code" && request.method === "POST") {
        const key = await this.loginLimit(request, "recovery-code");
        const globalRequest = new Request(request.url, {
          headers: { "CF-Connecting-IP": "manager-recovery-global" },
        });
        const globalKey = await this.loginLimit(
          globalRequest,
          "manager-recovery",
        );
        const state = await this.state();
        const member = await verifyManagerRecoveryCode(
          this.env.DB,
          state.staff,
          payload.code,
        );
        if (!member) {
          await this.failedLogin(key);
          await this.failedLogin(globalKey);
          throw new HttpError(401, "Incorrect or expired recovery code.");
        }
        return json({ ok: true, username: member.username });
      }
      if (path === "/api/recover-manager" && request.method === "POST") {
        const login = username(payload.username);
        const key = await this.loginLimit(request, `recovery:${login}`);
        const globalRequest = new Request(request.url, {
          headers: { "CF-Connecting-IP": "manager-recovery-global" },
        });
        const globalKey = await this.loginLimit(
          globalRequest,
          "manager-recovery",
        );
        const state = await this.state();
        const member = state.staff.find((staff) => staff.username === login);
        let recovered;
        try {
          recovered = await recoverManager(this.env.DB, member, payload);
        } catch (error) {
          throw new HttpError(
            400,
            error instanceof Error ? error.message : "Recovery failed.",
          );
        }
        if (!recovered) {
          await this.failedLogin(key);
          await this.failedLogin(globalKey);
          await this.env.DB.prepare(
            "INSERT INTO audit_events (id, created_at, actor_staff_id, actor_username, actor_role, action, entity_type, entity_id, reason, request_id) VALUES (?, ?, NULL, ?, 'unknown', 'account.recovery.failed', 'staff', NULL, 'Invalid manager account or recovery code', ?)",
          )
            .bind(id(), now(), login, requestId)
            .run();
          throw new HttpError(401, "Invalid manager account or recovery code.");
        }
        await this.env.DB.prepare(
          "INSERT INTO audit_events (id, created_at, actor_staff_id, actor_username, actor_role, action, entity_type, entity_id, reason, request_id) VALUES (?, ?, ?, ?, 'manager', 'account.recovery', 'staff', ?, 'One-time manager recovery; code rotated', ?)",
        )
          .bind(id(), now(), member!.id, login, member!.id, requestId)
          .run();
        return json({ ok: true }, 200, {
          "Set-Cookie": cookie(request, "", 0),
        });
      }
      if (path === "/api/login" && request.method === "POST") {
        const state = await this.state();
        const login = username(payload.username);
        const limitKey = await this.loginLimit(request, login);
        const pass =
          typeof payload.password === "string" && payload.password.length <= 128
            ? payload.password
            : "";
        const user = state.staff.find((staff) => staff.username === login);
        const credential = user
          ? await this.env.DB.prepare(
              "SELECT hash FROM credentials WHERE id = ?",
            )
              .bind(user.id)
              .first<{ hash: string }>()
          : null;
        const valid = matches(
          pass,
          credential?.hash || makeHash("invalid-login-placeholder"),
        );
        if (!user || !valid) {
          await this.failedLogin(limitKey);
          await this.env.DB.prepare(
            "INSERT INTO audit_events (id, created_at, actor_staff_id, actor_username, actor_role, action, entity_type, entity_id, reason, request_id) VALUES (?, ?, NULL, ?, 'unknown', 'login.failed', 'session', NULL, 'Invalid credentials', ?)",
          )
            .bind(id(), now(), login, requestId)
            .run();
          throw new HttpError(401, "Invalid username or password.");
        }
        requireThat(user.active, "Your account has been suspended.", 403);
        requireThat(
          state.settings.open || user.role === "manager",
          "Restaurant is closed. Please ask your manager to reopen it.",
          403,
        );
        const setCookie = await this.createSession(request, user);
        await this.env.DB.batch([
          this.env.DB.prepare(
            "DELETE FROM login_attempts WHERE attempt_key = ?",
          ).bind(limitKey),
          this.env.DB.prepare(
            "INSERT INTO audit_events (id, created_at, actor_staff_id, actor_username, actor_role, action, entity_type, entity_id, request_id) VALUES (?, ?, ?, ?, ?, 'login.success', 'session', ?, ?)",
          ).bind(
            id(),
            now(),
            user.id,
            user.username,
            user.role,
            sha256(sessionToken(request) || requestId).slice(0, 16),
            requestId,
          ),
        ]);
        return json(snapshot(state, user), 200, { "Set-Cookie": setCookie });
      }
      if (path === "/api/logout" && request.method === "POST") {
        await this.env.DB.prepare("DELETE FROM sessions WHERE token = ?")
          .bind(sha256(sessionToken(request)))
          .run();
        return json({ ok: true }, 200, {
          "Set-Cookie": cookie(request, "", 0),
        });
      }
      const state = await this.state();
      const user = await this.account(request, state);
      if (
        user.mustChangePassword &&
        path === "/api/action" &&
        payload.action !== "account.password"
      )
        throw new HttpError(
          403,
          "Change your manager password before continuing.",
        );
      if (path === "/api/state" && request.method === "GET")
        return json(snapshot(state, user));
      if (path === "/api/version" && request.method === "GET")
        return json({
          stateVersion: state.stateVersion,
          updatedAt: state.updatedAt,
        });
      if (path === "/api/sessions" && request.method === "GET") {
        manager(user);
        const sessions = await this.env.DB.prepare(
          "SELECT staffId, expires, created_at, last_seen_at, user_agent FROM sessions WHERE expires > ? ORDER BY last_seen_at DESC LIMIT 100",
        )
          .bind(Date.now())
          .all();
        return json({ sessions: sessions.results });
      }
      if (path === "/api/audit" && request.method === "GET") {
        manager(user);
        const limit = Math.min(
          100,
          Math.max(1, Number(url.searchParams.get("limit") || 50)),
        );
        const cursor =
          url.searchParams.get("before") || "9999-12-31T23:59:59.999Z";
        const events = await this.env.DB.prepare(
          "SELECT id, created_at, actor_staff_id, actor_username, actor_role, action, entity_type, entity_id, reason, before_value, after_value, request_id FROM audit_events WHERE created_at < ? ORDER BY created_at DESC LIMIT ?",
        )
          .bind(cursor, limit)
          .all();
        return json({
          events: events.results,
          next:
            events.results.length === limit
              ? (events.results.at(-1) as any).created_at
              : null,
        });
      }
      if (path === "/api/action" && request.method === "POST") {
        const mutationId =
          payload.mutationId === undefined
            ? ""
            : text(payload.mutationId, "Mutation ID", 64);
        if (mutationId)
          requireThat(
            /^[a-f0-9]{32}$/.test(mutationId),
            "Invalid mutation ID.",
          );
        if (
          [
            "order.create",
            "order.advance",
            "order.cancel",
            "sale.pay",
            "sale.reverse",
          ].includes(payload.action)
        )
          requireThat(
            Boolean(mutationId),
            "A mutation ID is required for order and payment changes.",
          );
        if (mutationId) {
          const applied = await this.env.DB.prepare(
            "SELECT id FROM mutations WHERE id = ?",
          )
            .bind(mutationId)
            .first<{ id: string }>();
          if (applied) return json(snapshot(state, user));
        }
        const effects: Effects = { credentials: new Map(), revoke: new Set() };
        if (payload.action === "staff.save") {
          const parameters = payload.payload || {};
          const existing = state.staff.find(
            (staff) => staff.id === parameters.id,
          );
          if (!existing || parameters.password) {
            manager(user);
            const credential = await this.env.DB.prepare(
              "SELECT hash FROM credentials WHERE id = ?",
            )
              .bind(user.id)
              .first<{ hash: string }>();
            const managerPassword =
              typeof parameters.managerPassword === "string" &&
              parameters.managerPassword.length <= 128
                ? parameters.managerPassword
                : "";
            requireThat(
              Boolean(credential && matches(managerPassword, credential.hash)),
              "Manager password is incorrect.",
              403,
            );
          }
        }
        if (payload.action === "account.password") {
          const credential = await this.env.DB.prepare(
            "SELECT hash FROM credentials WHERE id = ?",
          )
            .bind(user.id)
            .first<{ hash: string }>();
          const currentPassword =
            typeof payload.payload?.currentPassword === "string"
              ? payload.payload.currentPassword
              : "";
          requireThat(
            Boolean(credential && matches(currentPassword, credential.hash)),
            "Current password is incorrect.",
            403,
          );
        }
        const previous = structuredClone(state);
        mutate(state, user, payload.action, payload.payload || {}, effects);
        const statements = incrementalStatements(
          this.env.DB,
          previous,
          state,
          payload.action,
          payload.payload || {},
        );
        for (const [staffId, hash] of effects.credentials)
          statements.push(
            this.env.DB.prepare(
              "INSERT INTO credentials (id, hash) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash",
            ).bind(staffId, hash),
          );
        for (const staffId of effects.revoke)
          statements.push(
            this.env.DB.prepare("DELETE FROM sessions WHERE staffId = ?").bind(
              staffId,
            ),
          );
        if (mutationId) {
          statements.push(
            this.env.DB.prepare(
              "INSERT INTO mutations (id, staffId, createdAt) VALUES (?, ?, ?)",
            ).bind(mutationId, user.id, Date.now()),
          );
          statements.push(
            this.env.DB.prepare(
              "DELETE FROM mutations WHERE createdAt < ?",
            ).bind(Date.now() - 30 * 86400000),
          );
        }
        const entityId =
          payload.payload?.id ||
          payload.payload?.staffId ||
          (payload.action === "order.create"
            ? state.orders.find(
                (entry) => !previous.orders.some((old) => old.id === entry.id),
              )?.id
            : undefined) ||
          (payload.action === "sale.pay"
            ? state.sales.find(
                (entry) => !previous.sales.some((old) => old.id === entry.id),
              )?.id
            : undefined);
        const entityType = payload.action.startsWith("order.")
          ? "order"
          : payload.action.startsWith("sale.")
            ? "payment"
            : payload.action.startsWith("staff.")
              ? "staff"
              : payload.action.startsWith("table.")
                ? "table"
                : payload.action.startsWith("menu.")
                  ? "menu"
                  : payload.action.startsWith("settings.")
                    ? "settings"
                    : payload.action.startsWith("sessions.")
                      ? "session"
                      : "account";
        const reason =
          typeof payload.payload?.reason === "string"
            ? payload.payload.reason.slice(0, 300)
            : null;
        statements.push(
          this.env.DB.prepare(
            "INSERT INTO audit_events (id, created_at, actor_staff_id, actor_username, actor_role, action, entity_type, entity_id, reason, before_value, after_value, session_id, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).bind(
            id(),
            now(),
            user.id,
            user.username,
            user.role,
            payload.action,
            entityType,
            entityId ? String(entityId) : null,
            reason,
            JSON.stringify({ version: previous.stateVersion }),
            JSON.stringify({ version: state.stateVersion }),
            sha256(sessionToken(request)).slice(0, 16),
            requestId,
          ),
        );
        await this.env.DB.batch(statements);
        return json(snapshot(state, user));
      }
      throw new HttpError(404, "Not found.");
    } catch (error) {
      const known =
        error instanceof HttpError || error instanceof CancellationError;
      console.error(
        JSON.stringify({
          level: known && error.status < 500 ? "warn" : "error",
          requestId,
          method: request.method,
          endpoint: new URL(request.url).pathname,
          category: known ? "request" : "exception",
          status: known ? error.status : 500,
          message: known
            ? error.message
            : error instanceof Error
              ? error.message
              : "Unknown error",
          timestamp: now(),
        }),
      );
      return json(
        {
          error: known
            ? error.message
            : "The server could not complete this request.",
          requestId,
        },
        known ? error.status : 500,
        { "X-Request-ID": requestId },
      );
    }
  }
}

const allowedMobileOrigins = new Set([
  "capacitor://localhost",
  "http://localhost",
  "https://localhost",
]);
function secureHeaders(response: Response) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://sajilo-restaurant.aryalprabesh300.workers.dev; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  return response;
}
function cors(request: Request, response: Response) {
  const origin = request.headers.get("Origin") || "";
  if (allowedMobileOrigins.has(origin)) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.append("Vary", "Origin");
  }
  return response;
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const origin = request.headers.get("Origin");
      if (request.method === "OPTIONS") {
        if (!origin || !allowedMobileOrigins.has(origin))
          return secureHeaders(
            json({ error: "Cross-origin request rejected." }, 403),
          );
        return secureHeaders(
          cors(
            request,
            new Response(null, {
              status: 204,
              headers: {
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers":
                  "Content-Type, X-Sajilo-Session",
              },
            }),
          ),
        );
      }
      if (
        request.method === "POST" &&
        origin &&
        !allowedMobileOrigins.has(origin) &&
        new URL(origin).host !== url.host
      )
        return secureHeaders(
          json({ error: "Cross-origin request rejected." }, 403),
        );
      const objectId = env.RESTAURANT_COORDINATOR.idFromName("main");
      const upstream =
        await env.RESTAURANT_COORDINATOR.get(objectId).fetch(request);
      return secureHeaders(
        cors(request, new Response(upstream.body, upstream)),
      );
    }
    if (url.pathname === "/health") {
      const checkedAt = now();
      try {
        const result = await env.DB.prepare(
          "SELECT version, updated_at FROM state_versions WHERE id = 1",
        ).first<any>();
        return secureHeaders(
          json(
            {
              ok: Boolean(result),
              database: "cloudflare-d1",
              stateVersion: result?.version,
              updatedAt: result?.updated_at,
              checkedAt,
            },
            result ? 200 : 503,
          ),
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            action: "health.database",
            message:
              error instanceof Error ? error.message : "D1 health check failed",
            timestamp: checkedAt,
          }),
        );
        return secureHeaders(
          json({ ok: false, database: "unavailable", checkedAt }, 503),
        );
      }
    }
    if (url.pathname === "/download" || url.pathname === "/download/") {
      url.pathname = "/download/Sajilo-Restaurant-release.apk";
      return secureHeaders(
        new Response(null, {
          status: 302,
          headers: { Location: url.toString() },
        }),
      );
    }
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    if (url.pathname === "/" || /\.(?:html|js|json|css)$/.test(url.pathname))
      response.headers.set("Cache-Control", "no-cache, must-revalidate");
    if (
      url.pathname === "/download/Sajilo-Restaurant-release.apk" &&
      response.ok
    )
      response.headers.set(
        "Content-Disposition",
        'attachment; filename="Sajilo-Restaurant-release.apk"',
      );
    return secureHeaders(cors(request, response));
  },
} satisfies ExportedHandler<Env>;
