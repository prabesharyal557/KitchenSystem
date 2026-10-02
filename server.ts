import { cancelTickets, CancellationError } from "./cancellation.ts";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { calculateBill, roundMoney } from "./domain.ts";

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
const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(root, "data");
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, "sajilo.sqlite"));
db.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, staffId TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS mutations (id TEXT PRIMARY KEY, staffId TEXT NOT NULL, createdAt INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS mutations_createdAt_idx ON mutations(createdAt); CREATE TABLE IF NOT EXISTS user_consents (user_id TEXT NOT NULL, policy_version TEXT NOT NULL, terms_version TEXT NOT NULL, privacy_version TEXT NOT NULL, consented_at TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('web', 'android', 'ios')), PRIMARY KEY(user_id, policy_version)); CREATE INDEX IF NOT EXISTS user_consents_consented_at_idx ON user_consents(consented_at);",
);
function ensureColumn(table: string, name: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((column) => column.name === name))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
ensureColumn("sessions", "created_at", "INTEGER");
ensureColumn("sessions", "last_seen_at", "INTEGER");
ensureColumn("sessions", "user_agent", "TEXT");
db.exec(`
  CREATE TABLE IF NOT EXISTS state_versions (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, updated_at TEXT NOT NULL);
  INSERT OR IGNORE INTO state_versions (id, version, updated_at) VALUES (1, 1, CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, actor_staff_id TEXT, actor_username TEXT NOT NULL,
    actor_role TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT,
    reason TEXT, before_value TEXT, after_value TEXT, session_id TEXT, request_id TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC);
`);
const id = () => randomBytes(12).toString("hex");
const now = () => new Date().toISOString();
const round = roundMoney;
function hash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 64).toString("hex");
}
function matches(password: string, stored: string) {
  const [salt, key] = stored.split(":");
  return timingSafeEqual(
    scryptSync(password, salt, 64),
    Buffer.from(key, "hex"),
  );
}
const dummyHash = hash(randomBytes(32).toString("hex"));
const sessionSeconds = 30 * 24 * 60 * 60;
const sessionMilliseconds = sessionSeconds * 1000;
function read(): State {
  const state = JSON.parse(
    (db.prepare("SELECT body FROM state WHERE id=1").get() as { body: string })
      .body,
  ) as State;
  state.staff = state.staff.map((staff) => ({
    ...staff,
    mustChangePassword: Boolean(staff.mustChangePassword),
  }));
  state.orders = state.orders.map((order) => ({
    ...order,
    version: order.version || 1,
    updatedAt: order.updatedAt || order.createdAt,
  }));
  state.sales = state.sales.map((sale) => ({
    ...sale,
    status: sale.status || "completed",
    orderIds: sale.orderIds || [],
  }));
  state.payments = state.payments.map((payment) => ({
    ...payment,
    baseSalary: payment.baseSalary ?? 0,
    adjustment: payment.adjustment ?? 0,
    remainingAfter: payment.remainingAfter ?? 0,
  }));
  const version = db
    .prepare("SELECT version, updated_at FROM state_versions WHERE id=1")
    .get() as { version: number; updated_at: string };
  state.stateVersion = version.version;
  state.updatedAt = version.updated_at;
  return state;
}
function save(state: State) {
  db.prepare("INSERT OR REPLACE INTO state VALUES (1, ?)").run(
    JSON.stringify(state),
  );
}
const freshDatabase = !db.prepare("SELECT id FROM state WHERE id=1").get();
if (freshDatabase)
  save({
    settings: { name: "Himalayan Bites", open: true, taxRate: 0 },
    tables: Array.from({ length: 12 }, (_, i) => ({
      n: i + 1,
      seats: 4,
      status: "available",
    })),
    menu: [
      ["Momo", "Chicken Momo", 180],
      ["Momo", "Veg Momo", 140],
      ["Noodles", "Chicken Chowmein", 220],
      ["Noodles", "Veg Chowmein", 180],
      ["Rice", "Chicken Fried Rice", 240],
      ["Drinks", "Coke", 80],
      ["Drinks", "Lemon Soda", 90],
    ].map(([category, name, price], rank) => ({
      id: id(),
      category: String(category),
      name: String(name),
      price: Number(price),
      cost: 0,
      available: true,
      rank,
    })),
    orders: [],
    sales: [],
    staff: [],
    payments: [],
  });
if (freshDatabase && process.env.INITIAL_RESTAURANT_STATE) {
  const restored = JSON.parse(process.env.INITIAL_RESTAURANT_STATE);
  const fields = [
    "tables",
    "menu",
    "orders",
    "sales",
    "staff",
    "payments",
  ] as const;
  if (
    !restored.settings ||
    fields.some((field) => !Array.isArray(restored[field]))
  )
    throw new Error("Invalid initial restaurant backup");
  const state = read();
  state.settings = restored.settings;
  for (const field of fields) state[field] = restored[field];
  save(state);
}
const initialManagerPassword = process.env.INITIAL_MANAGER_PASSWORD;
if (initialManagerPassword) {
  const state = read();
  const initialManagerUsername = (
    process.env.INITIAL_MANAGER_USERNAME || "prabesh"
  )
    .trim()
    .toLowerCase();
  const initialManagerName = (
    process.env.INITIAL_MANAGER_NAME || "Prabesh"
  ).trim();
  if (!/^[a-z0-9._-]+$/.test(initialManagerUsername))
    throw new Error("INITIAL_MANAGER_USERNAME is invalid.");
  if (initialManagerPassword.length < 12 || initialManagerPassword.length > 128)
    throw new Error("INITIAL_MANAGER_PASSWORD must contain 12–128 characters.");
  let initialManager = state.staff.find(
    (staff) => staff.role === "manager" && staff.active,
  );
  const stored = initialManager
    ? (db
        .prepare("SELECT hash FROM credentials WHERE id=?")
        .get(initialManager.id) as { hash: string } | undefined)
    : undefined;
  const passwordChanged =
    !stored || !matches(initialManagerPassword, stored.hash);
  const profileChanged =
    !initialManager ||
    initialManager.username !== initialManagerUsername ||
    initialManager.name !== initialManagerName;
  if (passwordChanged || profileChanged) {
    if (!initialManager) {
      initialManager = {
        id: id(),
        name: initialManagerName,
        username: initialManagerUsername,
        role: "manager",
        salary: 0,
        active: true,
        joined: now(),
      };
      state.staff.push(initialManager);
    } else {
      initialManager.name = initialManagerName;
      initialManager.username = initialManagerUsername;
    }
    initialManager.mustChangePassword = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (passwordChanged)
        db.prepare("INSERT OR REPLACE INTO credentials VALUES (?, ?)").run(
          initialManager.id,
          hash(initialManagerPassword),
        );
      db.prepare("DELETE FROM sessions WHERE staffId=?").run(initialManager.id);
      save(state);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const requireThat = (condition: unknown, message: string, status = 400) => {
  if (!condition) throw new HttpError(status, message);
};
function text(v: unknown, label: string, max = 100) {
  requireThat(
    typeof v === "string" && v.trim().length > 0 && v.trim().length <= max,
    `${label} is required (maximum ${max} characters).`,
  );
  return (v as string).trim();
}
function num(v: unknown, label: string, min = 0, max = 10000000) {
  requireThat(
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max,
    `${label} must be between ${min} and ${max}.`,
  );
  return round(v as number);
}
function password(v: unknown) {
  requireThat(
    typeof v === "string" && v.length >= 12 && v.length <= 128,
    "Use a password with 12–128 characters.",
  );
  return v as string;
}
function boolean(v: unknown) {
  requireThat(typeof v === "boolean", "Expected a true or false value.");
  return v as boolean;
}
function username(v: unknown) {
  const name = text(v, "Username", 40).toLowerCase();
  requireThat(
    /^[a-z0-9._-]+$/.test(name),
    "Use letters, numbers, dots, hyphens or underscores in usernames.",
  );
  return name;
}
function sessionCookieName(req: IncomingMessage) {
  const scope = req.headers["x-sajilo-session"];
  if (scope === undefined) return "sajilo"; // Existing API clients retain their session.
  requireThat(
    typeof scope === "string" && /^[a-f0-9]{32}$/.test(scope),
    "Invalid session selector.",
  );
  return `sajilo_${scope}`;
}
function sessionKey(req: IncomingMessage) {
  const name = sessionCookieName(req);
  const token =
    new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(
      req.headers.cookie || "",
    )?.[1] || "";
  return createHash("sha256").update(token).digest("hex");
}
function account(req: IncomingMessage, state: State) {
  const token = sessionKey(req);
  const s = db
    .prepare(
      "SELECT staffId, last_seen_at FROM sessions WHERE token=? AND expires>?",
    )
    .get(token, Date.now()) as
    { staffId: string; last_seen_at: number | null } | undefined;
  const u = state.staff.find((u) => u.id === s?.staffId && u.active);
  requireThat(u, "Please sign in.", 401);
  requireThat(
    state.settings.open || u!.role === "manager",
    "Restaurant is closed. Staff access is suspended until a manager opens it.",
    403,
  );
  if (!s!.last_seen_at || s!.last_seen_at < Date.now() - 300000)
    db.prepare("UPDATE sessions SET last_seen_at=? WHERE token=?").run(
      Date.now(),
      token,
    );
  return u!;
}
function manager(u: Staff) {
  requireThat(u.role === "manager", "Manager access required.", 403);
}
function sessionCookieAttributes(req: IncomingMessage) {
  const mobile = [
    "capacitor://localhost",
    "http://localhost",
    "https://localhost",
  ].includes(req.headers.origin || "");
  return `HttpOnly; SameSite=${mobile ? "None" : "Strict"}; Path=/${mobile || process.env.SECURE_COOKIE === "1" ? "; Secure" : ""}`;
}
function session(req: IncomingMessage, res: ServerResponse, user: Staff) {
  const name = sessionCookieName(req);
  const token = randomBytes(32).toString("hex");
  db.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now());
  db.prepare(
    "INSERT INTO sessions (token, staffId, expires, created_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    createHash("sha256").update(token).digest("hex"),
    user.id,
    Date.now() + sessionMilliseconds,
    Date.now(),
    Date.now(),
    String(req.headers["user-agent"] || "unknown").slice(0, 300),
  );
  res.setHeader(
    "Set-Cookie",
    `${name}=${token}; ${sessionCookieAttributes(req)}; Max-Age=${sessionSeconds}`,
  );
}
const limits = new Map<string, { count: number; reset: number }>();
function loginLimit(req: IncomingMessage) {
  const key = req.socket.remoteAddress || "";
  const t = Date.now();
  for (const [k, v] of limits) if (v.reset < t) limits.delete(k);
  const l = limits.get(key) || { count: 0, reset: t + 900000 };
  requireThat(
    l.count < 20,
    "Too many sign-in attempts. Try again in 15 minutes.",
    429,
  );
  l.count++;
  limits.set(key, l);
}
async function body(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    requireThat(Buffer.byteLength(raw) < 65536, "Request too large.", 413);
  }
  let value;
  try {
    value = JSON.parse(raw || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
  requireThat(
    value && typeof value === "object" && !Array.isArray(value),
    "Expected a JSON object.",
  );
  return value;
}
function output(res: ServerResponse, code: number, value: unknown) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
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
          (o) =>
            !o.paid &&
            ["new", "preparing", "ready", "cancelled"].includes(o.status),
        )
        .map((o) => ({
          ...o,
          items: o.items.map(({ cost, price, ...i }) => i),
        })),
      user,
    };
  return {
    settings: state.settings,
    stateVersion: state.stateVersion,
    updatedAt: state.updatedAt,
    tables: state.tables,
    menu: state.menu.map(({ cost, ...i }) => i),
    orders: state.orders.map((o) => ({
      ...o,
      items: o.items.map(({ cost, ...i }) => i),
    })),
    user,
  };
}
function mutate(state: State, u: Staff, action: string, p: any) {
  requireThat(
    p && typeof p === "object" && !Array.isArray(p),
    "Expected action parameters.",
  );
  if (action === "order.create") {
    requireThat(
      ["manager", "waiter"].includes(u.role),
      "Waiter access required.",
      403,
    );
    const table = state.tables.find((t) => t.n === p.table);
    requireThat(table, "Table no longer exists.");
    requireThat(
      Array.isArray(p.items) && p.items.length > 0 && p.items.length <= 100,
      "Select 1–100 items.",
    );
    const items = p.items.map((line: any) => {
      requireThat(line && typeof line === "object", "Invalid order line.");
      const item = state.menu.find((i) => i.id === line.id && i.available);
      requireThat(item, "An item is unavailable. Refresh your order.");
      const qty = num(line.qty, "Quantity", 1, 100);
      requireThat(Number.isInteger(qty), "Quantity must be a whole number.");
      return {
        id: item!.id,
        name: item!.name,
        price: item!.price,
        cost: item!.cost,
        qty,
      };
    });
    const orderId = p.clientOrderId
      ? text(p.clientOrderId, "Offline order ID", 40)
      : id();
    requireThat(
      !p.clientOrderId || /^offline-[a-f0-9]{32}$/.test(orderId),
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
      table: table!.n,
      status: "new",
      items,
      createdAt,
      paid: false,
      version: 1,
      updatedAt: createdAt,
    });
    table!.status = "busy";
    return;
  }
  if (action === "order.advance") {
    requireThat(
      (["manager", "kitchen"].includes(u.role) && p.status !== "ready") ||
        (u.role === "waiter" && p.status === "ready"),
      "Only managers or kitchen staff can mark orders ready. Only waiters can mark ready orders served.",
      403,
    );
    const o = state.orders.find((o) => o.id === p.id && !o.paid);
    requireThat(
      o && ["new", "preparing", "ready"].includes(o.status),
      "Order cannot be advanced.",
    );
    requireThat(
      o!.status === p.status,
      "Order already updated. Refresh and try again.",
      409,
    );
    if (p.expectedVersion !== undefined)
      requireThat(
        o!.version === p.expectedVersion,
        "This order changed on another device. Refresh before trying again.",
        409,
      );
    o!.status = (
      { new: "ready", preparing: "ready", ready: "served" } as Record<
        string,
        string
      >
    )[o!.status];
    o!.version += 1;
    o!.updatedAt = now();
    if (o!.status === "served") {
      o!.servedAt = now();
      o!.servedById = u.id;
    }
    return;
  }
  if (action === "order.cancel") {
    cancelTickets(state, u, p, id);
    return;
  }
  if (action === "sale.pay") {
    requireThat(
      ["manager", "waiter"].includes(u.role),
      "Waiter access required.",
      403,
    );
    const orders = state.orders.filter(
      (o) => o.table === p.table && !o.paid && o.status !== "cancelled",
    );
    requireThat(orders.length, "This table has no unpaid orders.");
    requireThat(
      orders.every((o) => o.status === "served"),
      "Mark all orders served before payment.",
    );
    requireThat(
      ["Cash", "QR", "Card"].includes(p.method),
      "Choose a payment method.",
    );
    const items = orders.flatMap((o) => o.items);
    const { subtotal, cost, tax, total } = calculateBill(
      items,
      state.settings.taxRate,
    );
    requireThat(
      p.expectedTotal === total,
      "The bill changed. Review the updated bill before collecting payment.",
      409,
    );
    state.sales.unshift({
      id: id(),
      table: p.table,
      items,
      subtotal,
      cost,
      taxRate: state.settings.taxRate,
      tax,
      total,
      method: p.method,
      createdAt: now(),
      status: "completed",
      orderIds: orders.map((order) => order.id),
    });
    orders.forEach((o) => {
      o.paid = true;
      o.version += 1;
      o.updatedAt = now();
    });
    state.tables.find((t) => t.n === p.table)!.status = "available";
    return;
  }
  manager(u);
  if (action === "table.add") {
    const n = num(p.n, "Table number", 1, 999);
    const seats = num(p.seats, "Seats", 1, 50);
    requireThat(
      Number.isInteger(n) && Number.isInteger(seats),
      "Table and seats must be whole numbers.",
    );
    requireThat(
      !state.tables.some((t) => t.n === n),
      "Table number already exists.",
    );
    state.tables.push({ n, seats, status: "available" });
    state.tables.sort((a, b) => a.n - b.n);
  } else if (action === "table.update" || action === "table.delete") {
    const t = state.tables.find((t) => t.n === p.n);
    requireThat(t, "Table not found.");
    const occupied = state.orders.some(
      (o) => o.table === p.n && !o.paid && o.status !== "cancelled",
    );
    requireThat(
      !occupied || (action === "table.update" && p.status === "busy"),
      "Settle the outstanding bill before freeing or deleting this table.",
    );
    if (action === "table.delete")
      state.tables = state.tables.filter((t) => t.n !== p.n);
    else {
      requireThat(
        ["available", "busy", "pending"].includes(p.status),
        "Invalid table status.",
      );
      t!.status = p.status;
    }
  } else if (action === "menu.save") {
    const existing = state.menu.find((i) => i.id === p.id);
    requireThat(!p.id || existing, "Menu item not found.");
    const item: Item = {
      id: existing?.id || id(),
      name: text(p.name, "Item name"),
      category: text(p.category, "Category"),
      price: num(p.price, "Price"),
      cost: num(p.cost, "Ingredient cost"),
      rank: num(p.rank, "Sort position", 0, 9999),
      available: boolean(p.available),
    };
    if (existing) Object.assign(existing, item);
    else state.menu.push(item);
  } else if (action === "menu.delete") {
    requireThat(
      state.menu.some((i) => i.id === p.id),
      "Item not found.",
    );
    state.menu = state.menu.filter((i) => i.id !== p.id);
  } else if (action === "staff.save") {
    const existing = state.staff.find((s) => s.id === p.id);
    const oldRole = existing?.role;
    requireThat(!p.id || existing, "Staff member not found.");
    const name = username(p.username);
    requireThat(
      !state.staff.some((s) => s.username === name && s.id !== p.id),
      "Username is already taken.",
    );
    requireThat(
      ["manager", "waiter", "kitchen"].includes(p.role),
      "Invalid role.",
    );
    const active = boolean(p.active);
    requireThat(
      p.id !== u.id || (active && p.role === "manager"),
      "You cannot suspend or demote your own account.",
    );
    const member: Staff = {
      id: existing?.id || id(),
      name: text(p.name, "Name"),
      username: name,
      role: p.role,
      salary: num(p.salary, "Monthly salary"),
      active,
      joined: existing?.joined || now(),
      mustChangePassword: Boolean(
        p.role === "manager" &&
        (existing ? (p.password ? true : existing.mustChangePassword) : true),
      ),
    };
    if (!existing || p.password) {
      const managerCredential = db
        .prepare("SELECT hash FROM credentials WHERE id=?")
        .get(u.id) as { hash: string } | undefined;
      const managerPassword =
        typeof p.managerPassword === "string" && p.managerPassword.length <= 128
          ? p.managerPassword
          : "";
      requireThat(
        Boolean(
          managerCredential && matches(managerPassword, managerCredential.hash),
        ),
        "Manager password is incorrect.",
        403,
      );
      db.prepare("INSERT OR REPLACE INTO credentials VALUES (?, ?)").run(
        member.id,
        hash(password(p.password)),
      );
    }
    if (existing) Object.assign(existing, member);
    else state.staff.push(member);
    if (existing && (p.password || !active || oldRole !== member.role))
      db.prepare("DELETE FROM sessions WHERE staffId=?").run(member.id);
  } else if (action === "staff.payment") {
    requireThat(
      state.staff.some((s) => s.id === p.staffId),
      "Staff member not found.",
    );
    requireThat(
      /^\d{4}-(0[1-9]|1[0-2])$/.test(p.month),
      "Choose a salary month.",
    );
    requireThat(
      ["Salary", "Advance"].includes(p.kind),
      "Choose salary or advance.",
    );
    const staff = state.staff.find((entry) => entry.id === p.staffId)!;
    const amount = num(p.amount, "Payment", 0.01);
    const paidForPeriod = state.payments
      .filter((entry) => entry.staffId === staff.id && entry.month === p.month)
      .reduce((sum, entry) => sum + entry.amount, 0);
    state.payments.unshift({
      id: id(),
      staffId: p.staffId,
      amount,
      month: p.month,
      kind: p.kind,
      note: typeof p.note === "string" ? p.note.slice(0, 300) : "",
      createdAt: now(),
      baseSalary: staff.salary,
      adjustment: 0,
      remainingAfter: round(staff.salary - paidForPeriod - amount),
    });
  } else if (action === "sale.reverse") {
    const sale = state.sales.find((entry) => entry.id === p.id);
    requireThat(
      sale && sale.status === "completed",
      "Payment is not available for reversal.",
      409,
    );
    const reason = text(p.reason, "Correction reason", 300);
    requireThat(reason.length >= 3, "Enter a correction reason.");
    sale!.status = p.type === "refund" ? "refunded" : "voided";
    sale!.correctedAt = now();
    sale!.correctionReason = reason;
    sale!.correctedById = u.id;
    for (const order of state.orders.filter((entry) =>
      sale!.orderIds.includes(entry.id),
    )) {
      order.paid = false;
      order.version += 1;
      order.updatedAt = sale!.correctedAt!;
    }
    const table = state.tables.find((entry) => entry.n === sale!.table);
    if (table && sale!.orderIds.length) table.status = "busy";
  } else if (action === "account.password") {
    const credential = db
      .prepare("SELECT hash FROM credentials WHERE id=?")
      .get(u.id) as { hash: string } | undefined;
    requireThat(
      Boolean(
        credential && matches(String(p.currentPassword || ""), credential.hash),
      ),
      "Current password is incorrect.",
      403,
    );
    db.prepare("INSERT OR REPLACE INTO credentials VALUES (?, ?)").run(
      u.id,
      hash(password(p.newPassword)),
    );
    db.prepare("DELETE FROM sessions WHERE staffId=?").run(u.id);
    u.mustChangePassword = false;
  } else if (action === "sessions.revoke_all") {
    const staffId = p.staffId ? text(p.staffId, "Staff ID", 64) : u.id;
    requireThat(
      state.staff.some((entry) => entry.id === staffId),
      "Staff member not found.",
    );
    db.prepare("DELETE FROM sessions WHERE staffId=?").run(staffId);
  } else if (action === "settings.save") {
    state.settings = {
      name: text(p.name, "Restaurant name"),
      open: boolean(p.open),
      taxRate: num(p.taxRate, "Tax rate", 0, 100),
    };
    if (!p.open)
      for (const s of state.staff.filter((s) => s.role !== "manager"))
        db.prepare("DELETE FROM sessions WHERE staffId=?").run(s.id);
  } else throw new HttpError(404, "Unknown action.");
}
const assets: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/manager.html": "manager.html",
  "/waiter.html": "waiter.html",
  "/kitchen.html": "kitchen.html",
  "/terms.html": "terms.html",
  "/privacy.html": "privacy.html",
  "/app.js": "app.js",
  "/app-version.json": "app-version.json",
  "/sw.js": "sw.js",
  "/manifest.webmanifest": "manifest.webmanifest",
  "/style.css": "style.css",
  "/auth.css": "auth.css",
  "/favicon.svg": "favicon.svg",
  "/apple-touch-icon.png": "apple-touch-icon.png",
};
const mime: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  json: "application/json",
  css: "text/css",
  svg: "image/svg+xml",
  png: "image/png",
  webmanifest: "application/manifest+json",
};
async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const requestId = id();
  res.setHeader("X-Request-ID", requestId);
  const origin = req.headers.origin;
  const capacitorOrigin =
    origin === "capacitor://localhost" ||
    origin === "http://localhost" ||
    origin === "https://localhost";
  if (capacitorOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin!);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  if (
    req.method === "OPTIONS" &&
    new URL(req.url || "/", "http://localhost").pathname.startsWith("/api/")
  ) {
    if (capacitorOrigin) {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-Sajilo-Session",
      });
      res.end();
      return;
    }
    output(res, 403, { error: "Cross-origin request rejected." });
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://sajilo-restaurant.onrender.com https://sajilo-restaurant.aryalprabesh300.workers.dev; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  try {
    const path = new URL(req.url || "/", "http://localhost").pathname;
    if (path.startsWith("/api/")) {
      sessionCookieName(req);
      requireThat(
        ["GET", "POST"].includes(req.method || ""),
        "Method not allowed.",
        405,
      );
      if (req.method === "POST") {
        requireThat(
          req.headers["content-type"]?.startsWith("application/json"),
          "JSON content type required.",
          415,
        );
        if (req.headers.origin && !capacitorOrigin)
          requireThat(
            new URL(req.headers.origin).host === req.headers.host,
            "Cross-origin request rejected.",
            403,
          );
      }
      if (path === "/api/bootstrap" && req.method === "GET") {
        output(res, 200, { setup: false });
        return;
      }
      const p = req.method === "POST" ? await body(req) : {};
      if (path === "/api/setup" && req.method === "POST") {
        loginLimit(req);
        const s = read();
        requireThat(s.staff.length === 0, "Setup is already complete.", 409);
        const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress || "",
        );
        requireThat(
          local,
          "Initial setup must be completed on the server computer.",
          403,
        );
        const user: Staff = {
          id: id(),
          name: text(p.name, "Manager name"),
          username: username(p.username),
          role: "manager",
          salary: 0,
          active: true,
          joined: now(),
        };
        const hashed = hash(password(p.password));
        db.exec("BEGIN IMMEDIATE");
        try {
          s.staff.push(user);
          db.prepare("INSERT INTO credentials VALUES (?, ?)").run(
            user.id,
            hashed,
          );
          save(s);
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        session(req, res, user);
        limits.delete(req.socket.remoteAddress || "");
        output(res, 200, { user });
        return;
      }
      if (path === "/api/login" && req.method === "POST") {
        loginLimit(req);
        const s = read();
        const name = username(p.username);
        const pass =
          typeof p.password === "string" && p.password.length <= 128
            ? p.password
            : "";
        const u = s.staff.find((u) => u.username === name);
        const credential =
          u &&
          (db.prepare("SELECT hash FROM credentials WHERE id=?").get(u.id) as
            { hash: string } | undefined);
        const valid = matches(pass, credential?.hash || dummyHash);
        if (!u || !valid) {
          db.prepare(
            "INSERT INTO audit_events (id, created_at, actor_staff_id, actor_username, actor_role, action, entity_type, reason, request_id) VALUES (?, ?, NULL, ?, 'unknown', 'login.failed', 'session', 'Invalid credentials', ?)",
          ).run(id(), now(), name, requestId);
          throw new HttpError(401, "Invalid username or password.");
        }
        requireThat(u!.active, "Your account has been suspended.", 403);
        requireThat(
          s.settings.open || u!.role === "manager",
          "Restaurant is closed. Please ask your manager to reopen it.",
          403,
        );
        session(req, res, u!);
        db.prepare(
          "INSERT INTO audit_events (id, created_at, actor_staff_id, actor_username, actor_role, action, entity_type, entity_id, request_id) VALUES (?, ?, ?, ?, ?, 'login.success', 'session', ?, ?)",
        ).run(id(), now(), u!.id, u!.username, u!.role, u!.id, requestId);
        limits.delete(req.socket.remoteAddress || "");
        output(res, 200, snapshot(s, u!));
        return;
      }
      if (path === "/api/logout" && req.method === "POST") {
        db.prepare("DELETE FROM sessions WHERE token=?").run(sessionKey(req));
        res.setHeader(
          "Set-Cookie",
          `${sessionCookieName(req)}=; ${sessionCookieAttributes(req)}; Max-Age=0`,
        );
        output(res, 200, { ok: true });
        return;
      }
      const s = read();
      const u = account(req, s);
      if (path === "/api/state" && req.method === "GET") {
        output(res, 200, snapshot(s, u));
        return;
      }
      if (path === "/api/version" && req.method === "GET") {
        output(res, 200, {
          stateVersion: s.stateVersion,
          updatedAt: s.updatedAt,
        });
        return;
      }
      if (path === "/api/sessions" && req.method === "GET") {
        manager(u);
        const sessions = db
          .prepare(
            "SELECT staffId, expires, created_at, last_seen_at, user_agent FROM sessions WHERE expires > ? ORDER BY last_seen_at DESC LIMIT 100",
          )
          .all(Date.now());
        output(res, 200, { sessions });
        return;
      }
      if (path === "/api/audit" && req.method === "GET") {
        manager(u);
        const url = new URL(req.url || "/", "http://localhost");
        const limit = Math.min(
          100,
          Math.max(1, Number(url.searchParams.get("limit") || 50)),
        );
        const cursor =
          url.searchParams.get("before") || "9999-12-31T23:59:59.999Z";
        const events = db
          .prepare(
            "SELECT id, created_at, actor_staff_id, actor_username, actor_role, action, entity_type, entity_id, reason, before_value, after_value, request_id FROM audit_events WHERE created_at < ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(cursor, limit) as any[];
        output(res, 200, {
          events,
          next: events.length === limit ? events.at(-1)?.created_at : null,
        });
        return;
      }
      if (path === "/api/action" && req.method === "POST") {
        if (u.mustChangePassword && p.action !== "account.password")
          throw new HttpError(
            403,
            "Change your manager password before continuing.",
          );
        const mutationId =
          p.mutationId === undefined
            ? ""
            : text(p.mutationId, "Mutation ID", 64);
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
          ].includes(p.action)
        )
          requireThat(
            Boolean(mutationId),
            "A mutation ID is required for order and payment changes.",
          );
        if (
          mutationId &&
          db.prepare("SELECT id FROM mutations WHERE id=?").get(mutationId)
        ) {
          output(res, 200, snapshot(s, u));
          return;
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          const previousVersion = s.stateVersion || 1;
          mutate(s, u, p.action, p.payload || {});
          const updatedAt = now();
          db.prepare(
            "UPDATE state_versions SET version=version+1, updated_at=? WHERE id=1",
          ).run(updatedAt);
          s.stateVersion = previousVersion + 1;
          s.updatedAt = updatedAt;
          save(s);
          if (mutationId) {
            db.prepare(
              "INSERT INTO mutations (id, staffId, createdAt) VALUES (?, ?, ?)",
            ).run(mutationId, u.id, Date.now());
            db.prepare("DELETE FROM mutations WHERE createdAt < ?").run(
              Date.now() - 30 * 86400000,
            );
          }
          const entityId = p.payload?.id || p.payload?.staffId || null;
          const entityType = String(p.action).split(".")[0] || "action";
          db.prepare(
            "INSERT INTO audit_events (id, created_at, actor_staff_id, actor_username, actor_role, action, entity_type, entity_id, reason, before_value, after_value, session_id, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            id(),
            now(),
            u.id,
            u.username,
            u.role,
            String(p.action),
            entityType,
            entityId,
            typeof p.payload?.reason === "string"
              ? p.payload.reason.slice(0, 300)
              : null,
            JSON.stringify({ version: previousVersion }),
            JSON.stringify({ version: s.stateVersion }),
            sessionKey(req).slice(0, 16),
            requestId,
          );
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        output(res, 200, snapshot(s, u));
        return;
      }
      throw new HttpError(404, "Not found.");
    }
    if (path === "/health") {
      requireThat(req.method === "GET", "Method not allowed.", 405);
      const version = db
        .prepare("SELECT version, updated_at FROM state_versions WHERE id=1")
        .get();
      output(res, 200, {
        ok: true,
        database: "sqlite",
        state: version,
        checkedAt: now(),
      });
      return;
    }
    if (path === "/download" || path === "/download/") {
      requireThat(req.method === "GET", "Method not allowed.", 405);
      res.writeHead(302, {
        Location: "/download/Sajilo-Restaurant-release.apk",
      });
      res.end();
      return;
    }
    if (path === "/download/Sajilo-Restaurant-release.apk") {
      requireThat(req.method === "GET", "Method not allowed.", 405);
      const apk = join(root, "downloads", "Sajilo-Restaurant-release.apk");
      requireThat(existsSync(apk), "APK has not been built yet.", 404);
      res.writeHead(200, {
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Disposition":
          'attachment; filename="Sajilo-Restaurant-release.apk"',
      });
      res.end(readFileSync(apk));
      return;
    }
    requireThat(req.method === "GET", "Method not allowed.", 405);
    const file = assets[path];
    requireThat(file, "Not found.", 404);
    res.setHeader(
      "Content-Type",
      `${mime[file.split(".").pop()!]} ; charset=utf-8`,
    );
    res.end(readFileSync(join(root, file)));
  } catch (error) {
    const known =
      error instanceof HttpError || error instanceof CancellationError;
    console.error(
      JSON.stringify({
        level: known && error.status < 500 ? "warn" : "error",
        requestId,
        method: req.method,
        endpoint: new URL(req.url || "/", "http://localhost").pathname,
        status: known ? error.status : 500,
        message: known
          ? error.message
          : error instanceof Error
            ? error.message
            : "Unknown error",
        timestamp: now(),
      }),
    );
    output(res, known ? error.status : 500, {
      error: known
        ? error.message
        : "The server could not complete this request.",
    });
  }
}

let writeQueue: Promise<void> = Promise.resolve();
const localServer = createServer((req, res) => {
  const path = new URL(req.url || "/", "http://localhost").pathname;
  if (req.method === "POST" && path === "/api/action") {
    const response = writeQueue.then(
      () => handleRequest(req, res),
      () => handleRequest(req, res),
    );
    writeQueue = response.then(
      () => undefined,
      () => undefined,
    );
  } else void handleRequest(req, res);
});

localServer.listen(
  Number(process.env.PORT || 3000),
  process.env.HOST || "127.0.0.1",
  () =>
    console.log(
      `Sajilo ready at http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3000}`,
    ),
);
