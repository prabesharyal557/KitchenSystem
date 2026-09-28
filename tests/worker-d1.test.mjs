import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import { once } from "node:events";

const root = join(import.meta.dirname, "..");
const directory = mkdtempSync(join(tmpdir(), "sajilo-worker-contract-"));
const persist = join(directory, "wrangler");
const configHome = join(directory, "config");
const base = "http://127.0.0.1:3147";
const wranglerBin = join(
  root,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
let worker;

const hash = (password) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
};
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const mutation = (suffix) => suffix.toString(16).padStart(32, "0");

const initialState = {
  settings: { name: "Contract Restaurant", open: true, taxRate: 13 },
  tables: [{ n: 1, seats: 4, status: "available" }],
  menu: [
    {
      id: "menu-momo",
      name: "Chicken Momo",
      category: "Momo",
      price: 200,
      cost: 100,
      available: true,
      rank: 1,
    },
  ],
  orders: [],
  sales: [],
  staff: [
    {
      id: "manager-1",
      name: "Test Manager",
      username: "manager",
      role: "manager",
      salary: 0,
      active: true,
      joined: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "waiter-1",
      name: "Test Waiter",
      username: "waiter",
      role: "waiter",
      salary: 20000,
      active: true,
      joined: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "kitchen-1",
      name: "Test Kitchen",
      username: "kitchen",
      role: "kitchen",
      salary: 20000,
      active: true,
      joined: "2026-01-01T00:00:00.000Z",
    },
  ],
  payments: [],
};

function wrangler(args) {
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1", XDG_CONFIG_HOME: configHome },
  });
  if (result.status !== 0)
    throw new Error(
      `wrangler ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

async function request(path, payload, cookie) {
  const response = await fetch(`${base}/api/${path}`, {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}
async function login(username, password) {
  const result = await request("login", { username, password });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(typeof result.data.user?.id, "string");
  return result.cookie;
}
const act = (cookie, action, payload, mutationId) =>
  request("action", { action, payload, mutationId }, cookie);

before(async () => {
  mkdirSync(persist, { recursive: true });
  wrangler([
    "d1",
    "migrations",
    "apply",
    "sajilo-restaurant",
    "--local",
    "--persist-to",
    persist,
  ]);
  const seed = join(directory, "seed.sql");
  writeFileSync(
    seed,
    [
      `INSERT INTO state (id, body) VALUES (1, ${quote(JSON.stringify(initialState))});`,
      `INSERT INTO credentials (id, hash) VALUES ('manager-1', ${quote(hash("test-manager-password"))});`,
      `INSERT INTO credentials (id, hash) VALUES ('waiter-1', ${quote(hash("test-waiter-password"))});`,
      `INSERT INTO credentials (id, hash) VALUES ('kitchen-1', ${quote(hash("test-kitchen-password"))});`,
    ].join("\n"),
  );
  wrangler([
    "d1",
    "execute",
    "sajilo-restaurant",
    "--local",
    "--persist-to",
    persist,
    "--file",
    seed,
  ]);

  worker = spawn(
    process.execPath,
    [
      wranglerBin,
      "dev",
      "--local",
      "--port",
      "3147",
      "--persist-to",
      persist,
      "--log-level",
      "error",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: root,
      env: { ...process.env, CI: "1", XDG_CONFIG_HOME: configHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  worker.stdout.on("data", (chunk) => (output += chunk));
  worker.stderr.on("data", (chunk) => (output += chunk));
  for (let attempt = 0; attempt < 160; attempt++) {
    try {
      const response = await fetch(`${base}/api/bootstrap`);
      if (response.ok) return;
    } catch {}
    if (worker.exitCode !== null)
      throw new Error(`Worker stopped during startup.\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Worker startup timed out.\n${output}`);
});

after(async () => {
  if (worker && worker.exitCode === null) {
    worker.kill("SIGTERM");
    await once(worker, "exit");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
  }
});

test("Worker/D1 action contract preserves the complete POS flow and management actions", async () => {
  const manager = await login("manager", "test-manager-password");
  const waiter = await login("waiter", "test-waiter-password");
  const kitchen = await login("kitchen", "test-kitchen-password");

  let response = await act(
    waiter,
    "table.add",
    { n: 2, seats: 2 },
    mutation(1),
  );
  assert.equal(response.status, 403);
  response = await act(manager, "table.add", { n: 2, seats: 2 }, mutation(2));
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.ok(response.data.tables.some((table) => table.n === 2));
  response = await act(
    manager,
    "table.update",
    { n: 2, status: "pending" },
    mutation(3),
  );
  assert.equal(response.status, 200);
  response = await act(manager, "table.delete", { n: 2 }, mutation(4));
  assert.equal(response.status, 200);

  response = await act(
    manager,
    "menu.save",
    {
      name: "Tea",
      category: "Drinks",
      price: 40,
      cost: 10,
      rank: 2,
      available: true,
    },
    mutation(5),
  );
  assert.equal(response.status, 200);
  const tea = response.data.menu.find((item) => item.name === "Tea");
  assert.ok(tea?.id);
  response = await act(manager, "menu.delete", { id: tea.id }, mutation(6));
  assert.equal(response.status, 200);

  response = await act(
    manager,
    "staff.save",
    {
      name: "Second Waiter",
      username: "waiter2",
      role: "waiter",
      salary: 18000,
      active: true,
      password: "second-waiter-password",
      managerPassword: "test-manager-password",
    },
    mutation(7),
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const waiter2 = response.data.staff.find(
    (staff) => staff.username === "waiter2",
  );
  response = await act(
    manager,
    "staff.payment",
    {
      staffId: waiter2.id,
      amount: 1000,
      month: "2026-09",
      kind: "Advance",
      note: "Contract",
    },
    mutation(8),
  );
  assert.equal(response.status, 200);
  response = await act(
    manager,
    "settings.save",
    { name: "Contract Restaurant", open: true, taxRate: 10 },
    mutation(9),
  );
  assert.equal(response.status, 200);

  response = await act(
    waiter,
    "order.create",
    { table: 1, items: [{ id: "menu-momo", qty: 2 }] },
    mutation(10),
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const order = response.data.orders.find(
    (entry) => entry.table === 1 && entry.status === "new",
  );
  assert.ok(order?.id);
  const duplicate = await act(
    waiter,
    "order.create",
    { table: 1, items: [{ id: "menu-momo", qty: 2 }] },
    mutation(10),
  );
  assert.equal(duplicate.status, 200);
  assert.equal(
    duplicate.data.orders.filter((entry) => entry.id === order.id).length,
    1,
  );
  response = await act(
    kitchen,
    "order.advance",
    { id: order.id, status: "new" },
    mutation(11),
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.data.orders.find((entry) => entry.id === order.id).status,
    "ready",
  );
  response = await act(
    waiter,
    "order.advance",
    { id: order.id, status: "ready" },
    mutation(12),
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.data.orders.find((entry) => entry.id === order.id).status,
    "served",
  );

  const expectedTotal = 440;
  const [payA, payB] = await Promise.all([
    act(
      waiter,
      "sale.pay",
      { table: 1, method: "Cash", expectedTotal },
      mutation(13),
    ),
    act(
      manager,
      "sale.pay",
      { table: 1, method: "Cash", expectedTotal },
      mutation(14),
    ),
  ]);
  assert.deepEqual([payA.status, payB.status].sort(), [200, 400]);
  response = await request("state", undefined, manager);
  assert.equal(response.status, 200);
  assert.equal(response.data.sales.length, 1);

  response = await act(
    waiter,
    "order.create",
    { table: 1, items: [{ id: "menu-momo", qty: 1 }] },
    mutation(15),
  );
  const cancelledId = response.data.orders.find(
    (entry) => !entry.paid && entry.status === "new",
  ).id;
  response = await act(
    waiter,
    "order.cancel",
    { id: cancelledId },
    mutation(16),
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(
    response.data.orders.find((entry) => entry.id === cancelledId).status,
    "cancelled",
  );
  assert.equal(
    response.data.tables.find((table) => table.n === 1).status,
    "available",
  );
  response = await act(
    waiter,
    "sale.pay",
    { table: 1, method: "Cash", expectedTotal: 220 },
    mutation(17),
  );
  assert.equal(response.status, 400);

  response = await request("state", undefined, manager);
  assert.equal(response.status, 200);
  assert.equal(
    response.data.orders.filter((entry) => entry.id === order.id).length,
    1,
  );
  assert.equal(response.data.sales.length, 1);
  assert.equal(
    response.data.orders.find((entry) => entry.id === cancelledId).status,
    "cancelled",
  );

  const audit = await request("audit?limit=100", undefined, manager);
  assert.equal(audit.status, 200);
  assert.ok(audit.data.events.some((event) => event.action === "order.cancel"));
  assert.ok(audit.data.events.some((event) => event.action === "sale.pay"));
  const sessions = await request("sessions", undefined, manager);
  assert.equal(sessions.status, 200);
  assert.ok(sessions.data.sessions.length >= 3);

  response = await act(
    manager,
    "sale.reverse",
    {
      id: response.data.sales[0].id,
      type: "void",
      reason: "Contract correction",
    },
    mutation(18),
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.sales[0].status, "voided");
  assert.ok(response.data.sales[0].orderIds.includes(order.id));
  assert.equal(
    response.data.orders.find((entry) => entry.id === order.id).paid,
    false,
  );
  response = await act(
    manager,
    "account.password",
    {
      currentPassword: "test-manager-password",
      newPassword: "rotated-manager-password",
    },
    mutation(19),
  );
  assert.equal(response.status, 200);
  assert.equal((await request("state", undefined, manager)).status, 401);
  const rotatedManager = await login("manager", "rotated-manager-password");
  assert.ok(rotatedManager);
});
