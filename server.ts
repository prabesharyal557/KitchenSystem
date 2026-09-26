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

type Role = "manager" | "waiter" | "kitchen";
type Staff = {
  id: string;
  name: string;
  username: string;
  role: Role;
  salary: number;
  active: boolean;
  joined: string;
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
  }[];
};
const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(root, "data");
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, "sajilo.sqlite"));
db.exec(
  "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, staffId TEXT NOT NULL, expires INTEGER NOT NULL);",
);
const id = () => randomBytes(12).toString("hex");
const now = () => new Date().toISOString();
const round = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
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
function read(): State {
  return JSON.parse(
    (db.prepare("SELECT body FROM state WHERE id=1").get() as { body: string })
      .body,
  );
}
function save(state: State) {
  db.prepare("INSERT OR REPLACE INTO state VALUES (1, ?)").run(
    JSON.stringify(state),
  );
}
if (!db.prepare("SELECT id FROM state WHERE id=1").get())
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
  const s = db
    .prepare("SELECT staffId FROM sessions WHERE token=? AND expires>?")
    .get(sessionKey(req), Date.now()) as { staffId: string } | undefined;
  const u = state.staff.find((u) => u.id === s?.staffId && u.active);
  requireThat(u, "Please sign in.", 401);
  requireThat(
    u!.role !== "kitchen",
    "The kitchen workspace has been removed. Ask your manager to update your role.",
    403,
  );
  requireThat(
    state.settings.open || u!.role === "manager",
    "Restaurant is closed. Staff access is suspended until a manager opens it.",
    403,
  );
  return u!;
}
function manager(u: Staff) {
  requireThat(u.role === "manager", "Manager access required.", 403);
}
function session(req: IncomingMessage, res: ServerResponse, user: Staff) {
  const name = sessionCookieName(req);
  const token = randomBytes(32).toString("hex");
  db.prepare("DELETE FROM sessions WHERE expires<=?").run(Date.now());
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(
    createHash("sha256").update(token).digest("hex"),
    user.id,
    Date.now() + 43200000,
  );
  res.setHeader(
    "Set-Cookie",
    `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.SECURE_COOKIE === "1" ? "; Secure" : ""}`,
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
  return {
    settings: state.settings,
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
    state.orders.unshift({
      id: id(),
      table: table!.n,
      status: "new",
      items,
      createdAt: now(),
      paid: false,
    });
    table!.status = "busy";
    return;
  }
  if (action === "order.advance") {
    requireThat(
      (u.role === "manager" && p.status !== "ready") ||
        (u.role === "waiter" && p.status === "ready"),
      "Only managers can mark orders ready. Only waiters can mark ready orders served.",
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
    o!.status = (
      { new: "ready", preparing: "ready", ready: "served" } as Record<
        string,
        string
      >
    )[o!.status];
    if (o!.status === "served") {
      o!.servedAt = now();
      o!.servedById = u.id;
    }
    return;
  }
  if (action === "sale.pay") {
    requireThat(
      ["manager", "waiter"].includes(u.role),
      "Waiter access required.",
      403,
    );
    const orders = state.orders.filter((o) => o.table === p.table && !o.paid);
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
    const subtotal = round(items.reduce((s, i) => s + i.price * i.qty, 0));
    const cost = round(items.reduce((s, i) => s + i.cost * i.qty, 0));
    const tax = round((subtotal * state.settings.taxRate) / 100);
    requireThat(
      p.expectedTotal === round(subtotal + tax),
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
      total: round(subtotal + tax),
      method: p.method,
      createdAt: now(),
    });
    orders.forEach((o) => (o.paid = true));
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
    const occupied = state.orders.some((o) => o.table === p.n && !o.paid);
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
    requireThat(["manager", "waiter"].includes(p.role), "Invalid role.");
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
    };
    if (!existing || p.password)
      db.prepare("INSERT OR REPLACE INTO credentials VALUES (?, ?)").run(
        member.id,
        hash(password(p.password)),
      );
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
    state.payments.unshift({
      id: id(),
      staffId: p.staffId,
      amount: num(p.amount, "Payment", 0.01),
      month: p.month,
      kind: p.kind,
      note: typeof p.note === "string" ? p.note.slice(0, 300) : "",
      createdAt: now(),
    });
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
  "/app.js": "app.js",
  "/style.css": "style.css",
  "/auth.css": "auth.css",
  "/favicon.svg": "favicon.svg",
};
const mime: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  css: "text/css",
  svg: "image/svg+xml",
};
createServer(async (req, res) => {
  const origin = req.headers.origin;
  const capacitorOrigin = origin === "capacitor://localhost" || origin === "http://localhost";
  if (capacitorOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin!);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS" && new URL(req.url || "/", "http://localhost").pathname.startsWith("/api/")) {
    if (capacitorOrigin) {
      res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Sajilo-Session" });
      res.end();
      return;
    }
    output(res, 403, { error: "Cross-origin request rejected." });
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
        output(res, 200, { setup: read().staff.length === 0 });
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
        requireThat(u && valid, "Invalid username or password.", 401);
        requireThat(u!.active, "Your account has been suspended.", 403);
        requireThat(
          u!.role !== "kitchen",
          "The kitchen workspace has been removed. Ask your manager to update your role.",
          403,
        );
        requireThat(
          s.settings.open || u!.role === "manager",
          "Restaurant is closed. Please ask your manager to reopen it.",
          403,
        );
        session(req, res, u!);
        limits.delete(req.socket.remoteAddress || "");
        output(res, 200, { user: u });
        return;
      }
      if (path === "/api/logout" && req.method === "POST") {
        db.prepare("DELETE FROM sessions WHERE token=?").run(sessionKey(req));
        res.setHeader(
          "Set-Cookie",
          `${sessionCookieName(req)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${process.env.SECURE_COOKIE === "1" ? "; Secure" : ""}`,
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
      if (path === "/api/action" && req.method === "POST") {
        db.exec("BEGIN IMMEDIATE");
        try {
          mutate(s, u, p.action, p.payload || {});
          save(s);
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
      output(res, 200, { ok: true });
      return;
    }
    if (path === "/download/app-debug.apk") {
      requireThat(req.method === "GET", "Method not allowed.", 405);
      const apk = join(root, "downloads", "Sajilo-Restaurant.apk");
      requireThat(existsSync(apk), "APK has not been built yet.", 404);
      res.writeHead(200, {
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Disposition": 'attachment; filename="Sajilo-Restaurant.apk"',
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
    const known = error instanceof HttpError;
    if (!known) console.error(error);
    output(res, known ? error.status : 500, {
      error: known
        ? error.message
        : "The server could not complete this request.",
    });
  }
}).listen(
  Number(process.env.PORT || 3000),
  process.env.HOST || "127.0.0.1",
  () =>
    console.log(
      `Sajilo ready at http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || 3000}`,
    ),
);
