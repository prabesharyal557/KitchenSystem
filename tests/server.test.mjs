import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";

const dir = mkdtempSync(join(tmpdir(), "sajilo-test-"));
const base = "http://127.0.0.1:3137";
let child,
  managerCookie,
  waiterCookie,
  kitchenCookie,
  staffId,
  menuId,
  orderId,
  saleId;
async function start() {
  child = spawn(process.execPath, ["server.ts"], {
    env: { ...process.env, PORT: "3137", DATA_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let error = "";
  child.stderr.on("data", (c) => (error += c));
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base + "/api/bootstrap");
      return;
    } catch {}
    if (child.exitCode !== null) throw new Error(error);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Server startup timed out: " + error);
}
async function stop() {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
}
async function request(path, payload, cookie = managerCookie, extra = {}) {
  const response = await fetch(base + "/api/" + path, {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0],
    headers: response.headers,
  };
}
async function action(action, payload, cookie) {
  return request("action", { action, payload }, cookie);
}
before(start);
after(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

test("login-only bootstrap, session cookies, unauthenticated access and static allowlist", async () => {
  assert.equal((await request("bootstrap")).data.setup, false);
  assert.equal((await request("state")).status, 401);
  const r = await request("setup", {
    name: "Test Manager",
    username: "manager",
    password: "test-manager-password",
  });
  assert.equal(r.status, 200);
  managerCookie = r.cookie;
  assert.match(r.headers.get("set-cookie"), /HttpOnly/);
  assert.match(r.headers.get("set-cookie"), /SameSite=Strict/);
  assert.equal(
    (
      await request("setup", {
        name: "Other",
        username: "other",
        password: "another-password",
      })
    ).status,
    409,
  );
  assert.equal((await fetch(base + "/server.ts")).status, 404);
  assert.equal((await fetch(base + "/data/sajilo.sqlite")).status, 404);
  const state = (await request("state")).data;
  assert.equal(state.sales.length, 0);
  assert.equal(state.orders.length, 0);
});
test("staff accounts, hashing, role boundaries and private payroll", async () => {
  const r = await action("staff.save", {
    name: "Waiter Test",
    username: "waiter",
    password: "waiter-test-password",
    role: "waiter",
    salary: 25000,
    active: true,
  });
  assert.equal(r.status, 200);
  staffId = r.data.staff.find((s) => s.username === "waiter").id;
  assert.equal(
    (
      await action("staff.save", {
        name: "Removed",
        username: "kitchen",
        password: "kitchen-test-password",
        role: "kitchen",
        salary: 30000,
        active: true,
      })
    ).status,
    400,
  );
  await action("staff.save", {
    name: "Legacy staff",
    username: "legacy",
    password: "legacy-test-password",
    role: "waiter",
    salary: 30000,
    active: true,
  });
  kitchenCookie = (
    await request("login", {
      username: "legacy",
      password: "legacy-test-password",
    })
  ).cookie;
  const legacyDb = new DatabaseSync(join(dir, "sajilo.sqlite"));
  const legacyState = JSON.parse(
    legacyDb.prepare("SELECT body FROM state WHERE id=1").get().body,
  );
  legacyState.staff.find((s) => s.username === "legacy").role = "kitchen";
  legacyDb
    .prepare("UPDATE state SET body=? WHERE id=1")
    .run(JSON.stringify(legacyState));
  legacyDb.close();
  assert.equal((await request("state", undefined, kitchenCookie)).status, 403);
  assert.equal(
    (
      await request("login", {
        username: "legacy",
        password: "legacy-test-password",
      })
    ).status,
    403,
  );
  assert.equal((await fetch(base + "/kitchen.html")).status, 404);
  waiterCookie = (
    await request("login", {
      username: "waiter",
      password: "waiter-test-password",
    })
  ).cookie;
  assert.equal(
    (await action("table.add", { n: 40, seats: 4 }, waiterCookie)).status,
    403,
  );
  const state = (await request("state", undefined, waiterCookie)).data;
  assert.equal(state.staff, undefined);
  assert.equal(state.payments, undefined);
  assert.equal(state.sales, undefined);
  assert.equal(state.menu[0].cost, undefined);
  const sqlite = new DatabaseSync(join(dir, "sajilo.sqlite"));
  const hash = sqlite
    .prepare("SELECT hash FROM credentials WHERE id=?")
    .get(staffId).hash;
  sqlite.close();
  assert.notEqual(hash, "waiter-test-password");
  assert.match(hash, /^[a-f0-9]+:[a-f0-9]+$/);
});
test("table creation, reservation, deletion and validation", async () => {
  assert.equal((await action("table.add", { n: 40, seats: 6 })).status, 200);
  assert.equal((await action("table.add", { n: 40, seats: 6 })).status, 400);
  assert.equal((await action("table.add", { n: 40.5, seats: 6 })).status, 400);
  const r = await action("table.update", { n: 40, status: "pending" });
  assert.equal(r.data.tables.find((t) => t.n === 40).status, "pending");
  assert.equal((await action("table.delete", { n: 40 })).status, 200);
});
test("menu categories, costs, availability and server-authoritative order pricing", async () => {
  let r = await action("menu.save", {
    name: "Special Momo",
    category: "Momo",
    price: 250,
    cost: 100,
    rank: 0,
    available: true,
  });
  menuId = r.data.menu.find((i) => i.name === "Special Momo").id;
  assert.equal(
    (
      await action("menu.save", {
        name: "Invalid",
        category: "Momo",
        price: -1,
        cost: 10,
        rank: 1,
        available: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await action(
        "order.create",
        { table: 1, items: [{ id: menuId, qty: 2, price: 1 }] },
        kitchenCookie,
      )
    ).status,
    403,
  );
  r = await action(
    "order.create",
    { table: 1, items: [{ id: menuId, qty: 2, price: 1 }] },
    waiterCookie,
  );
  assert.equal(r.status, 200);
  orderId = r.data.orders[0].id;
  assert.equal(r.data.orders[0].items[0].price, 250);
  assert.equal(r.data.tables[0].status, "busy");
  assert.equal((await action("table.delete", { n: 1 })).status, 400);
  assert.equal(
    (await action("table.update", { n: 1, status: "available" })).status,
    400,
  );
});
test("order progression, stale actions, bill tax and exactly-once payment", async () => {
  assert.equal(
    (
      await action(
        "sale.pay",
        { table: 1, method: "Cash", expectedTotal: 500 },
        waiterCookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await action(
        "order.advance",
        { id: orderId, status: "new" },
        waiterCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await action(
        "order.advance",
        { id: orderId, status: "new" },
        managerCookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await action(
        "order.advance",
        { id: orderId, status: "new" },
        managerCookie,
      )
    ).status,
    409,
  );
  assert.equal(
    (await request("state")).data.orders.find((o) => o.id === orderId).status,
    "ready",
  );
  assert.equal(
    (
      await action(
        "order.advance",
        { id: orderId, status: "ready" },
        managerCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await action(
        "order.advance",
        { id: orderId, status: "ready" },
        waiterCookie,
      )
    ).status,
    200,
  );
  await action("settings.save", {
    name: "Test Restaurant",
    open: true,
    taxRate: 13,
  });
  assert.equal(
    (
      await action(
        "sale.pay",
        { table: 1, method: "Cash", expectedTotal: 500 },
        waiterCookie,
      )
    ).status,
    409,
  );
  const results = await Promise.all([
    action(
      "sale.pay",
      { table: 1, method: "Cash", expectedTotal: 565 },
      waiterCookie,
    ),
    action(
      "sale.pay",
      { table: 1, method: "Cash", expectedTotal: 565 },
      waiterCookie,
    ),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  const s = (await request("state")).data;
  assert.equal(s.sales.length, 1);
  const sale = s.sales[0];
  saleId = sale.id;
  assert.equal(sale.subtotal, 500);
  assert.equal(sale.tax, 65);
  assert.equal(sale.cost, 200);
  assert.equal(sale.total, 565);
  assert.equal(sale.subtotal - sale.cost, 300);
  assert.ok(Date.parse(sale.createdAt));
  assert.equal(s.tables[0].status, "available");
  assert.equal(s.orders[0].paid, true);
  await action("menu.delete", { id: menuId });
  await action("settings.save", {
    name: "Test Restaurant",
    open: true,
    taxRate: 5,
  });
  assert.equal((await request("state")).data.sales[0].taxRate, 13);
});
test("salary and mid-month advances retain amount, month and notes", async () => {
  assert.equal(
    (
      await action("staff.payment", {
        staffId,
        amount: 5000,
        month: "2026-09",
        kind: "Advance",
        note: "Mid-month cash payment",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await action("staff.payment", {
        staffId,
        amount: 10000,
        month: "2026-09",
        kind: "Salary",
        note: "Part payment",
      })
    ).status,
    200,
  );
  const s = (await request("state")).data;
  const payments = s.payments.filter((p) => p.staffId === staffId);
  assert.equal(
    payments.reduce((a, p) => a + p.amount, 0),
    15000,
  );
  assert.equal(s.staff.find((s) => s.id === staffId).salary - 15000, 10000);
  assert.equal(
    (
      await action("staff.payment", {
        staffId,
        amount: -10,
        month: "2026-09",
        kind: "Salary",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await action("staff.payment", {
        staffId,
        amount: 10,
        month: "2026-13",
        kind: "Salary",
      })
    ).status,
    400,
  );
});
test("closure revokes staff sessions, reopening restores login, suspensions and resets work", async () => {
  await action("settings.save", {
    name: "Test Restaurant",
    open: false,
    taxRate: 5,
  });
  assert.equal((await request("state", undefined, waiterCookie)).status, 401);
  assert.equal((await request("state", undefined, kitchenCookie)).status, 401);
  assert.equal(
    (
      await request("login", {
        username: "waiter",
        password: "waiter-test-password",
      })
    ).status,
    403,
  );
  assert.equal((await request("state")).status, 200);
  await action("settings.save", {
    name: "Test Restaurant",
    open: true,
    taxRate: 5,
  });
  const s = (await request("state")).data,
    member = s.staff.find((s) => s.id === staffId);
  assert.equal(
    (await action("staff.save", { ...s.user, active: false })).status,
    400,
  );
  await action("staff.save", { ...member, active: false });
  const suspended = await request("login", {
    username: "waiter",
    password: "waiter-test-password",
  });
  assert.equal(suspended.status, 403);
  assert.equal(suspended.data.error, "Your account has been suspended.");
  assert.equal(suspended.cookie, undefined);
  const incorrect = await request("login", {
    username: "waiter",
    password: "incorrect-password",
  });
  assert.equal(incorrect.status, 401);
  assert.equal(incorrect.data.error, "Invalid username or password.");
  await action("staff.save", {
    ...member,
    active: true,
    password: "replacement-test-password",
  });
  assert.equal(
    (
      await request("login", {
        username: "waiter",
        password: "waiter-test-password",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("login", {
        username: "waiter",
        password: "replacement-test-password",
      })
    ).status,
    200,
  );
});
test("multiple devices retain independent sessions and logout only ends one session", async () => {
  const sessions = await Promise.all([
    request("login", {
      username: "manager",
      password: "test-manager-password",
    }),
    request("login", {
      username: "waiter",
      password: "replacement-test-password",
    }),
    request("login", {
      username: "waiter",
      password: "replacement-test-password",
    }),
    request("login", {
      username: "manager",
      password: "test-manager-password",
    }),
  ]);
  assert.ok(sessions.every((s) => s.status === 200));
  assert.equal(new Set(sessions.map((s) => s.cookie)).size, 4);
  const states = await Promise.all(
    sessions.map((s) => request("state", undefined, s.cookie)),
  );
  assert.deepEqual(
    states.map((s) => s.data.user.role),
    ["manager", "waiter", "waiter", "manager"],
  );
  await request("logout", {}, sessions[1].cookie);
  assert.equal(
    (await request("state", undefined, sessions[1].cookie)).status,
    401,
  );
  for (const index of [0, 2, 3])
    assert.equal(
      (await request("state", undefined, sessions[index].cookie)).status,
      200,
    );
});

test("browser tabs select separate HttpOnly sessions and cannot fall back to another account", async () => {
  const managerScope = "a".repeat(32),
    waiterScope = "b".repeat(32);
  const managerHeaders = { "X-Sajilo-Session": managerScope };
  const waiterHeaders = { "X-Sajilo-Session": waiterScope };
  const m = await request(
    "login",
    { username: "manager", password: "test-manager-password" },
    undefined,
    managerHeaders,
  );
  const w = await request(
    "login",
    { username: "waiter", password: "replacement-test-password" },
    undefined,
    waiterHeaders,
  );
  assert.equal(m.status, 200);
  assert.equal(w.status, 200);
  assert.match(m.cookie, new RegExp(`^sajilo_${managerScope}=`));
  assert.match(m.headers.get("set-cookie"), /HttpOnly/);
  const jar = `${managerCookie}; ${m.cookie}; ${w.cookie}`;
  assert.equal(
    (await request("state", undefined, jar, managerHeaders)).data.user.role,
    "manager",
  );
  assert.equal(
    (await request("state", undefined, jar, waiterHeaders)).data.user.role,
    "waiter",
  );
  assert.equal(
    (
      await request("state", undefined, jar, {
        "X-Sajilo-Session": "c".repeat(32),
      })
    ).status,
    401,
  );
  assert.equal(
    (await request("state", undefined, jar, { "X-Sajilo-Session": ".*" }))
      .status,
    400,
  );
  assert.equal(
    (
      await request(
        "action",
        { action: "table.add", payload: { n: 99, seats: 4 } },
        jar,
        waiterHeaders,
      )
    ).status,
    403,
  );
  const logout = await request("logout", {}, jar, waiterHeaders);
  assert.match(
    logout.headers.get("set-cookie"),
    new RegExp(`^sajilo_${waiterScope}=`),
  );
  assert.equal(
    (await request("state", undefined, jar, waiterHeaders)).status,
    401,
  );
  assert.equal(
    (await request("state", undefined, jar, managerHeaders)).status,
    200,
  );
});

test("cross-origin writes rejected and data survives restart", async () => {
  assert.equal(
    (
      await request(
        "action",
        { action: "table.add", payload: { n: 99, seats: 4 } },
        managerCookie,
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  await stop();
  await start();
  const s = (await request("state")).data;
  assert.equal(s.sales[0].id, saleId);
  assert.equal(s.payments.length, 2);
  assert.equal(s.settings.taxRate, 5);
  assert.ok(!JSON.stringify(s).includes("replacement-test-password"));
});
