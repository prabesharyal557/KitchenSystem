import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "sajilo-load-"));
const port = Number(process.env.LOAD_PORT || 3155);
const targetRps = Number(process.env.LOAD_RPS || 15);
const scenario =
  process.env.LOAD_SCENARIO ||
  (targetRps <= 15 ? "normal" : targetRps <= 30 ? "heavy" : "extreme");
const base = `http://127.0.0.1:${port}`;
const latencies = [];
const failures = [];
let mutationCounter = 1;
let server;

const mutation = () => (mutationCounter++).toString(16).padStart(32, "0");
const percentile = (values, value) =>
  values[Math.min(values.length - 1, Math.ceil(values.length * value) - 1)] ||
  0;
const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function request(path, payload, cookie, expected = [200]) {
  const started = performance.now();
  const response = await fetch(`${base}/api/${path}`, {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  latencies.push(performance.now() - started);
  const data = await response.json();
  if (!expected.includes(response.status))
    failures.push({ path, status: response.status, error: data.error });
  return {
    status: response.status,
    data,
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}
const action = (cookie, action, payload, mutationId = mutation(), expected) =>
  request("action", { action, payload, mutationId }, cookie, expected);

async function paced(jobs) {
  const interval = 1000 / targetRps;
  const started = performance.now();
  const pending = [];
  for (let index = 0; index < jobs.length; index++) {
    const due = started + index * interval;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    pending.push(jobs[index]());
  }
  return Promise.all(pending);
}

async function login(username, password) {
  const result = await request("login", { username, password });
  if (!result.cookie)
    throw new Error(
      `Login failed for ${username}: ${JSON.stringify(result.data)}`,
    );
  return result.cookie;
}

async function main() {
  server = spawn(process.execPath, ["server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      INITIAL_MANAGER_NAME: "Load Manager",
      INITIAL_MANAGER_USERNAME: "manager",
      INITIAL_MANAGER_PASSWORD: "load-manager-password",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOutput = "";
  server.stderr.on("data", (chunk) => (serverOutput += chunk));
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${base}/api/bootstrap`)).ok) break;
    } catch {}
    if (server.exitCode !== null) throw new Error(serverOutput);
    await sleep(50);
  }

  const manager = await login("manager", "load-manager-password");
  const roles = [
    ...Array.from({ length: 5 }, (_, index) => ({
      role: "waiter",
      username: `waiter${index + 1}`,
    })),
    ...Array.from({ length: 6 }, (_, index) => ({
      role: "kitchen",
      username: `kitchen${index + 1}`,
    })),
  ];
  for (const account of roles) {
    const result = await action(manager, "staff.save", {
      name: account.username,
      username: account.username,
      role: account.role,
      salary: 20000,
      active: true,
      password: `${account.username}-secure-password`,
      managerPassword: "load-manager-password",
    });
    if (result.status !== 200) throw new Error(JSON.stringify(result.data));
  }
  const waiters = await Promise.all(
    roles
      .filter((entry) => entry.role === "waiter")
      .map((entry) =>
        login(entry.username, `${entry.username}-secure-password`),
      ),
  );
  const kitchens = await Promise.all(
    roles
      .filter((entry) => entry.role === "kitchen")
      .map((entry) =>
        login(entry.username, `${entry.username}-secure-password`),
      ),
  );
  const initial = (await request("state", undefined, manager)).data;
  const menu = initial.menu.find((item) => item.available);
  const taxRate = initial.settings.taxRate;
  for (let table = 13; table <= 20; table++)
    await action(manager, "table.add", { n: table, seats: 4 });

  const orders = Array.from({ length: 40 }, (_, index) => {
    const mutationId = mutation();
    return {
      id: `offline-${mutationId}`,
      mutationId,
      table: (index % 20) + 1,
      waiter: waiters[index % waiters.length],
      kitchen: kitchens[index % kitchens.length],
      quantity: (index % 3) + 1,
    };
  });

  await paced(
    orders.map(
      (order) => () =>
        action(
          order.waiter,
          "order.create",
          {
            table: order.table,
            clientOrderId: order.id,
            items: [{ id: menu.id, qty: order.quantity }],
          },
          order.mutationId,
        ),
    ),
  );
  // Network retry of identical create mutations must be harmless.
  await Promise.all(
    orders.slice(0, 5).map((order) =>
      action(
        order.waiter,
        "order.create",
        {
          table: order.table,
          clientOrderId: order.id,
          items: [{ id: menu.id, qty: order.quantity }],
        },
        order.mutationId,
      ),
    ),
  );

  await paced(
    orders.map(
      (order) => () =>
        action(order.kitchen, "order.advance", {
          id: order.id,
          status: "new",
          expectedVersion: 1,
        }),
    ),
  );
  await paced(
    orders.map(
      (order) => () =>
        action(order.waiter, "order.advance", {
          id: order.id,
          status: "ready",
          expectedVersion: 2,
        }),
    ),
  );

  const tableTotals = new Map();
  for (const order of orders)
    tableTotals.set(
      order.table,
      (tableTotals.get(order.table) || 0) + menu.price * order.quantity,
    );
  const payments = [...tableTotals].map(([table, subtotal], index) => {
    const expectedTotal =
      Math.round(
        (subtotal + (subtotal * taxRate) / 100 + Number.EPSILON) * 100,
      ) / 100;
    const cookie = waiters[index % waiters.length];
    return () =>
      Promise.all([
        action(
          cookie,
          "sale.pay",
          { table, method: "Cash", expectedTotal },
          mutation(),
          [200, 400],
        ),
        action(
          manager,
          "sale.pay",
          { table, method: "Cash", expectedTotal },
          mutation(),
          [200, 400],
        ),
      ]);
  });
  const paymentResults = (await paced(payments)).flat();
  for (let index = 0; index < paymentResults.length; index += 2) {
    const statuses = paymentResults
      .slice(index, index + 2)
      .map((result) => result.status)
      .sort();
    if (statuses[0] !== 200 || statuses[1] !== 400)
      failures.push({ paymentRace: index / 2, statuses });
  }

  const final = (await request("state", undefined, manager)).data;
  const created = final.orders.filter((order) =>
    order.id.startsWith("offline-"),
  );
  const uniqueOrders = new Set(created.map((order) => order.id));
  const invalidStates = created.filter(
    (order) => order.status !== "served" || !order.paid,
  );
  const duplicates = created.length - uniqueOrders.size;
  const duplicatePayments =
    final.sales.length -
    new Set(final.sales.map((sale) => sale.table).values()).size;
  if (created.length !== 40)
    failures.push({ expectedOrders: 40, actualOrders: created.length });
  if (duplicates) failures.push({ duplicateOrders: duplicates });
  if (invalidStates.length)
    failures.push({ invalidStates: invalidStates.length });
  if (final.sales.length !== 20 || duplicatePayments)
    failures.push({ payments: final.sales.length, duplicatePayments });

  const sorted = latencies.toSorted((a, b) => a - b);
  const durationSeconds = sorted.reduce((sum, value) => sum + value, 0) / 1000;
  const result = {
    scenario,
    users: 13,
    targetRps,
    requests: sorted.length,
    p50Ms: Number(percentile(sorted, 0.5).toFixed(2)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
    p99Ms: Number(percentile(sorted, 0.99).toFixed(2)),
    errorRate: Number(
      (failures.length / Math.max(1, sorted.length)).toFixed(6),
    ),
    orders: created.length,
    payments: final.sales.length,
    duplicateOrders: duplicates,
    duplicatePayments,
    failures,
    aggregateRequestSeconds: Number(durationSeconds.toFixed(2)),
  };
  mkdirSync(join(root, "audit-results"), { recursive: true });
  writeFileSync(
    join(root, "audit-results", `load-${scenario}-${targetRps}rps.json`),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exitCode = 1;
}

try {
  await main();
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  rmSync(dataDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
