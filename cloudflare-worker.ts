import { DurableObject } from "cloudflare:workers";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

type Role = "manager" | "waiter" | "kitchen";
type Staff = { id: string; name: string; username: string; role: Role; salary: number; active: boolean; joined: string };
type Item = { id: string; name: string; category: string; price: number; cost: number; available: boolean; rank: number };
type Line = { id: string; name: string; price: number; cost: number; qty: number };
type Order = { id: string; table: number; status: string; items: Line[]; createdAt: string; paid: boolean; servedAt?: string; servedById?: string };
type Sale = { id: string; table: number; items: Line[]; subtotal: number; cost: number; taxRate: number; tax: number; total: number; method: string; createdAt: string };
type State = {
  settings: { name: string; open: boolean; taxRate: number };
  tables: { n: number; seats: number; status: string }[];
  menu: Item[];
  orders: Order[];
  sales: Sale[];
  staff: Staff[];
  payments: { id: string; staffId: string; amount: number; month: string; kind: string; note: string; createdAt: string }[];
};
type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  RESTAURANT_COORDINATOR: DurableObjectNamespace<RestaurantCoordinator>;
};
type Effects = { credentials: Map<string, string>; revoke: Set<string> };

const id = () => randomBytes(12).toString("hex");
const now = () => new Date().toISOString();
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function requireThat(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new HttpError(status, message);
}
function text(value: unknown, label: string, max = 100) {
  requireThat(typeof value === "string" && value.trim().length > 0 && value.trim().length <= max, `${label} is required (maximum ${max} characters).`);
  return value.trim();
}
function num(value: unknown, label: string, min = 0, max = 10_000_000) {
  requireThat(typeof value === "number" && Number.isFinite(value) && value >= min && value <= max, `${label} must be between ${min} and ${max}.`);
  return round(value);
}
function bool(value: unknown) {
  requireThat(typeof value === "boolean", "Expected a true or false value.");
  return value;
}
function password(value: unknown) {
  requireThat(typeof value === "string" && value.length >= 12 && value.length <= 128, "Use a password with 12–128 characters.");
  return value;
}
function username(value: unknown) {
  const name = text(value, "Username", 40).toLowerCase();
  requireThat(/^[a-z0-9._-]+$/.test(name), "Use letters, numbers, dots, hyphens or underscores in usernames.");
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
  return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(request.headers.get("Cookie") || "")?.[1] || "";
}
function cookie(request: Request, value: string, maxAge: number) {
  const crossOrigin = ["capacitor://localhost", "http://localhost", "https://localhost"].includes(request.headers.get("Origin") || "");
  return `${cookieName(request)}=${value}; HttpOnly; ${crossOrigin ? "SameSite=None; " : "SameSite=Strict; "}Secure; Path=/; Max-Age=${maxAge}`;
}
async function parseBody(request: Request) {
  const declared = Number(request.headers.get("Content-Length") || "0");
  requireThat(Number.isFinite(declared) && declared < 65_536, "Request too large.", 413);
  const raw = await request.text();
  requireThat(Buffer.byteLength(raw) < 65_536, "Request too large.", 413);
  let value: unknown;
  try { value = JSON.parse(raw || "{}"); } catch { throw new HttpError(400, "Invalid JSON."); }
  requireThat(value && typeof value === "object" && !Array.isArray(value), "Expected a JSON object.");
  return value as Record<string, any>;
}
function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}
function snapshot(state: State, user: Staff) {
  if (user.role === "manager") return { ...state, user };
  if (user.role === "kitchen")
    return {
      settings: state.settings,
      orders: state.orders
        .filter(
          (order) =>
            !order.paid &&
            ["new", "preparing", "ready"].includes(order.status),
        )
        .map((order) => ({
          ...order,
          items: order.items.map(({ cost, price, ...item }) => item),
        })),
      user,
    };
  return {
    settings: state.settings,
    tables: state.tables,
    menu: state.menu.map(({ cost, ...item }) => item),
    orders: state.orders.map((order) => ({ ...order, items: order.items.map(({ cost, ...item }) => item) })),
    user,
  };
}

function manager(user: Staff) { requireThat(user.role === "manager", "Manager access required.", 403); }

function mutate(state: State, user: Staff, action: string, payload: any, effects: Effects) {
  requireThat(payload && typeof payload === "object" && !Array.isArray(payload), "Expected action parameters.");
  if (action === "order.create") {
    requireThat(["manager", "waiter"].includes(user.role), "Waiter access required.", 403);
    const table = state.tables.find((entry) => entry.n === payload.table);
    requireThat(table, "Table no longer exists.");
    requireThat(Array.isArray(payload.items) && payload.items.length > 0 && payload.items.length <= 100, "Select 1–100 items.");
    const items = payload.items.map((line: any) => {
      requireThat(line && typeof line === "object", "Invalid order line.");
      const item = state.menu.find((entry) => entry.id === line.id && entry.available);
      requireThat(item, "An item is unavailable. Refresh your order.");
      const quantity = num(line.qty, "Quantity", 1, 100);
      requireThat(Number.isInteger(quantity), "Quantity must be a whole number.");
      return { id: item.id, name: item.name, price: item.price, cost: item.cost, qty: quantity };
    });
    state.orders.unshift({ id: id(), table: table.n, status: "new", items, createdAt: now(), paid: false });
    table.status = "busy";
    return;
  }
  if (action === "order.advance") {
    requireThat((["manager", "kitchen"].includes(user.role) && payload.status !== "ready") || (user.role === "waiter" && payload.status === "ready"), "Only managers or kitchen staff can mark orders ready. Only waiters can mark ready orders served.", 403);
    const order = state.orders.find((entry) => entry.id === payload.id && !entry.paid);
    requireThat(order && ["new", "preparing", "ready"].includes(order.status), "Order cannot be advanced.");
    requireThat(order.status === payload.status, "Order already updated. Refresh and try again.", 409);
    order.status = ({ new: "ready", preparing: "ready", ready: "served" } as Record<string, string>)[order.status];
    if (order.status === "served") { order.servedAt = now(); order.servedById = user.id; }
    return;
  }
  if (action === "sale.pay") {
    requireThat(["manager", "waiter"].includes(user.role), "Waiter access required.", 403);
    const orders = state.orders.filter((order) => order.table === payload.table && !order.paid);
    requireThat(orders.length, "This table has no unpaid orders.");
    requireThat(orders.every((order) => order.status === "served"), "Mark all orders served before payment.");
    requireThat(["Cash", "QR", "Card"].includes(payload.method), "Choose a payment method.");
    const items = orders.flatMap((order) => order.items);
    const subtotal = round(items.reduce((sum, item) => sum + item.price * item.qty, 0));
    const cost = round(items.reduce((sum, item) => sum + item.cost * item.qty, 0));
    const tax = round((subtotal * state.settings.taxRate) / 100);
    requireThat(payload.expectedTotal === round(subtotal + tax), "The bill changed. Review the updated bill before collecting payment.", 409);
    state.sales.unshift({ id: id(), table: payload.table, items, subtotal, cost, taxRate: state.settings.taxRate, tax, total: round(subtotal + tax), method: payload.method, createdAt: now() });
    orders.forEach((order) => { order.paid = true; });
    const table = state.tables.find((entry) => entry.n === payload.table);
    if (table) table.status = "available";
    return;
  }
  manager(user);
  if (action === "table.add") {
    const number = num(payload.n, "Table number", 1, 999);
    const seats = num(payload.seats, "Seats", 1, 50);
    requireThat(Number.isInteger(number) && Number.isInteger(seats), "Table and seats must be whole numbers.");
    requireThat(!state.tables.some((table) => table.n === number), "Table number already exists.");
    state.tables.push({ n: number, seats, status: "available" });
    state.tables.sort((a, b) => a.n - b.n);
  } else if (action === "table.update" || action === "table.delete") {
    const table = state.tables.find((entry) => entry.n === payload.n);
    requireThat(table, "Table not found.");
    const occupied = state.orders.some((order) => order.table === payload.n && !order.paid);
    requireThat(!occupied || (action === "table.update" && payload.status === "busy"), "Settle the outstanding bill before freeing or deleting this table.");
    if (action === "table.delete") state.tables = state.tables.filter((entry) => entry.n !== payload.n);
    else { requireThat(["available", "busy", "pending"].includes(payload.status), "Invalid table status."); table.status = payload.status; }
  } else if (action === "menu.save") {
    const existing = state.menu.find((item) => item.id === payload.id);
    requireThat(!payload.id || existing, "Menu item not found.");
    const item: Item = { id: existing?.id || id(), name: text(payload.name, "Item name"), category: text(payload.category, "Category"), price: num(payload.price, "Price"), cost: num(payload.cost, "Ingredient cost"), rank: num(payload.rank, "Sort position", 0, 9999), available: bool(payload.available) };
    if (existing) Object.assign(existing, item); else state.menu.push(item);
  } else if (action === "menu.delete") {
    requireThat(state.menu.some((item) => item.id === payload.id), "Item not found.");
    state.menu = state.menu.filter((item) => item.id !== payload.id);
  } else if (action === "staff.save") {
    const existing = state.staff.find((staff) => staff.id === payload.id);
    const oldRole = existing?.role;
    requireThat(!payload.id || existing, "Staff member not found.");
    const login = username(payload.username);
    requireThat(!state.staff.some((staff) => staff.username === login && staff.id !== payload.id), "Username is already taken.");
    requireThat(["manager", "waiter", "kitchen"].includes(payload.role), "Invalid role.");
    const active = bool(payload.active);
    requireThat(payload.id !== user.id || (active && payload.role === "manager"), "You cannot suspend or demote your own account.");
    const member: Staff = { id: existing?.id || id(), name: text(payload.name, "Name"), username: login, role: payload.role, salary: num(payload.salary, "Monthly salary"), active, joined: existing?.joined || now() };
    if (!existing || payload.password) effects.credentials.set(member.id, makeHash(password(payload.password)));
    if (existing) Object.assign(existing, member); else state.staff.push(member);
    if (existing && (payload.password || !active || oldRole !== member.role)) effects.revoke.add(member.id);
  } else if (action === "staff.payment") {
    requireThat(state.staff.some((staff) => staff.id === payload.staffId), "Staff member not found.");
    requireThat(/^\d{4}-(0[1-9]|1[0-2])$/.test(payload.month), "Choose a salary month.");
    requireThat(["Salary", "Advance"].includes(payload.kind), "Choose salary or advance.");
    state.payments.unshift({ id: id(), staffId: payload.staffId, amount: num(payload.amount, "Payment", 0.01), month: payload.month, kind: payload.kind, note: typeof payload.note === "string" ? payload.note.slice(0, 300) : "", createdAt: now() });
  } else if (action === "settings.save") {
    state.settings = { name: text(payload.name, "Restaurant name"), open: bool(payload.open), taxRate: num(payload.taxRate, "Tax rate", 0, 100) };
    if (!payload.open) state.staff.filter((staff) => staff.role !== "manager").forEach((staff) => effects.revoke.add(staff.id));
  } else throw new HttpError(404, "Unknown action.");
}

export class RestaurantCoordinator extends DurableObject<Env> {
  private attempts = new Map<string, { count: number; reset: number }>();
  private queue: Promise<void> = Promise.resolve();

  private async state() {
    const row = await this.env.DB.prepare("SELECT body FROM state WHERE id = 1").first<{ body: string }>();
    requireThat(row, "Restaurant database is not initialized.", 503);
    return JSON.parse(row.body) as State;
  }

  private rateLimit(request: Request) {
    const current = Date.now();
    for (const [key, value] of this.attempts) if (value.reset < current) this.attempts.delete(key);
    const key = request.headers.get("CF-Connecting-IP") || "unknown";
    const attempt = this.attempts.get(key) || { count: 0, reset: current + 900_000 };
    requireThat(attempt.count < 20, "Too many sign-in attempts. Try again in 15 minutes.", 429);
    attempt.count += 1;
    this.attempts.set(key, attempt);
    return key;
  }

  private async account(request: Request, state: State) {
    const token = sha256(sessionToken(request));
    const session = await this.env.DB.prepare("SELECT staffId FROM sessions WHERE token = ? AND expires > ?").bind(token, Date.now()).first<{ staffId: string }>();
    const user = state.staff.find((staff) => staff.id === session?.staffId && staff.active);
    requireThat(user, "Please sign in.", 401);
    requireThat(state.settings.open || user.role === "manager", "Restaurant is closed. Staff access is suspended until a manager opens it.", 403);
    return user;
  }

  private async createSession(request: Request, user: Staff) {
    const token = randomBytes(32).toString("hex");
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM sessions WHERE expires <= ?").bind(Date.now()),
      this.env.DB.prepare("INSERT INTO sessions (token, staffId, expires) VALUES (?, ?, ?)").bind(sha256(token), user.id, Date.now() + 43_200_000),
    ]);
    return cookie(request, token, 43_200);
  }

  async fetch(request: Request) {
    const response = this.queue.then(() => this.handle(request), () => this.handle(request));
    this.queue = response.then(() => undefined, () => undefined);
    return response;
  }

  private async handle(request: Request) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      cookieName(request);
      requireThat(["GET", "POST"].includes(request.method), "Method not allowed.", 405);
      if (request.method === "POST") requireThat(request.headers.get("Content-Type")?.startsWith("application/json"), "JSON content type required.", 415);
      if (path === "/api/bootstrap" && request.method === "GET") return json({ setup: false });
      const payload = request.method === "POST" ? await parseBody(request) : {};
      if (path === "/api/setup" && request.method === "POST") throw new HttpError(404, "Manager setup is disabled.");
      if (path === "/api/login" && request.method === "POST") {
        const limitKey = this.rateLimit(request);
        const state = await this.state();
        const login = username(payload.username);
        const pass = typeof payload.password === "string" && payload.password.length <= 128 ? payload.password : "";
        const user = state.staff.find((staff) => staff.username === login);
        const credential = user ? await this.env.DB.prepare("SELECT hash FROM credentials WHERE id = ?").bind(user.id).first<{ hash: string }>() : null;
        const valid = matches(pass, credential?.hash || makeHash("invalid-login-placeholder"));
        requireThat(user && valid, "Invalid username or password.", 401);
        requireThat(user.active, "Your account has been suspended.", 403);
        requireThat(state.settings.open || user.role === "manager", "Restaurant is closed. Please ask your manager to reopen it.", 403);
        const setCookie = await this.createSession(request, user);
        this.attempts.delete(limitKey);
        return json({ user }, 200, { "Set-Cookie": setCookie });
      }
      if (path === "/api/logout" && request.method === "POST") {
        await this.env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(sha256(sessionToken(request))).run();
        return json({ ok: true }, 200, { "Set-Cookie": cookie(request, "", 0) });
      }
      const state = await this.state();
      const user = await this.account(request, state);
      if (path === "/api/state" && request.method === "GET") return json(snapshot(state, user));
      if (path === "/api/action" && request.method === "POST") {
        const effects: Effects = { credentials: new Map(), revoke: new Set() };
        if (payload.action === "staff.save") {
          const parameters = payload.payload || {};
          const existing = state.staff.find((staff) => staff.id === parameters.id);
          if (!existing || parameters.password) {
            manager(user);
            const credential = await this.env.DB.prepare("SELECT hash FROM credentials WHERE id = ?").bind(user.id).first<{ hash: string }>();
            const managerPassword = typeof parameters.managerPassword === "string" && parameters.managerPassword.length <= 128 ? parameters.managerPassword : "";
            requireThat(Boolean(credential && matches(managerPassword, credential.hash)), "Manager password is incorrect.", 403);
          }
        }
        mutate(state, user, payload.action, payload.payload || {}, effects);
        const statements: D1PreparedStatement[] = [this.env.DB.prepare("UPDATE state SET body = ? WHERE id = 1").bind(JSON.stringify(state))];
        for (const [staffId, hash] of effects.credentials) statements.push(this.env.DB.prepare("INSERT INTO credentials (id, hash) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash").bind(staffId, hash));
        for (const staffId of effects.revoke) statements.push(this.env.DB.prepare("DELETE FROM sessions WHERE staffId = ?").bind(staffId));
        await this.env.DB.batch(statements);
        return json(snapshot(state, user));
      }
      throw new HttpError(404, "Not found.");
    } catch (error) {
      const known = error instanceof HttpError;
      if (!known) console.error(error);
      return json({ error: known ? error.message : "The server could not complete this request." }, known ? error.status : 500);
    }
  }
}

const allowedMobileOrigins = new Set(["capacitor://localhost", "http://localhost", "https://localhost"]);
function secureHeaders(response: Response) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
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
        if (!origin || !allowedMobileOrigins.has(origin)) return secureHeaders(json({ error: "Cross-origin request rejected." }, 403));
        return secureHeaders(cors(request, new Response(null, { status: 204, headers: { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Sajilo-Session" } })));
      }
      if (request.method === "POST" && origin && !allowedMobileOrigins.has(origin) && new URL(origin).host !== url.host) return secureHeaders(json({ error: "Cross-origin request rejected." }, 403));
      const objectId = env.RESTAURANT_COORDINATOR.idFromName("main");
      const upstream = await env.RESTAURANT_COORDINATOR.get(objectId).fetch(request);
      return secureHeaders(cors(request, new Response(upstream.body, upstream)));
    }
    if (url.pathname === "/health") return secureHeaders(json({ ok: true, database: "cloudflare-d1" }));
    if (url.pathname === "/download" || url.pathname === "/download/") {
      url.pathname = "/download/app-debug.apk";
      return secureHeaders(
        new Response(null, {
          status: 302,
          headers: { Location: url.toString() },
        }),
      );
    }
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    if (
      url.pathname === "/" ||
      /\.(?:html|js|css)$/.test(url.pathname)
    )
      response.headers.set("Cache-Control", "no-cache, must-revalidate");
    if (url.pathname === "/download/app-debug.apk" && response.ok) response.headers.set("Content-Disposition", 'attachment; filename="Sajilo-Restaurant.apk"');
    return secureHeaders(response);
  },
} satisfies ExportedHandler<Env>;
