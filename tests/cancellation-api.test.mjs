import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

test("API persists partial cancellation, shows it to kitchen, and cancels the table", async () => {
  const data = await mkdtemp(join(tmpdir(), "sajilo-cancel-"));
  const server = spawn(process.execPath, ["server.ts"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      PORT: "39871",
      HOST: "127.0.0.1",
      DATA_DIR: data,
      INITIAL_MANAGER_PASSWORD: "123456789012",
      SECURE_COOKIE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  server.stderr.on("data", (chunk) => (logs += chunk));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(logs || "Server did not start")),
        10000,
      );
      server.stdout.on("data", (chunk) => {
        if (String(chunk).includes("Sajilo ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
      server.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(logs));
      });
    });
    const base = "http://127.0.0.1:39871";
    const login = async (username, password) => {
      const response = await fetch(base + "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.headers.get("set-cookie").split(";")[0];
    };
    const cookie = await login("prabesh", "123456789012");
    const action = async (action, payload, expected = 200) => {
      const response = await fetch(base + "/api/action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: base,
        },
        body: JSON.stringify({
          action,
          payload,
          mutationId: randomBytes(16).toString("hex"),
        }),
      });
      const value = await response.json();
      assert.equal(response.status, expected, JSON.stringify(value));
      return value;
    };
    let state = await (
      await fetch(base + "/api/state", { headers: { Cookie: cookie } })
    ).json();
    state = await action("order.create", {
      table: 1,
      items: state.menu.slice(0, 2).map((i) => ({ id: i.id, qty: 1 })),
    });
    const order = state.orders[0];
    state = await action("order.cancel", {
      id: order.id,
      scope: "items",
      itemIndexes: [0],
      expectedVersion: order.version,
      reason: "Wrong item",
    });
    assert.equal(
      state.orders.filter((o) => o.status === "cancelled").length,
      1,
    );
    assert.equal(state.orders.find((o) => o.id === order.id).items.length, 1);
    const cancelled = state.orders.find((o) => o.status === "cancelled");
    await action(
      "order.advance",
      {
        id: cancelled.id,
        expectedVersion: cancelled.version,
        expectedStatus: "cancelled",
      },
      400,
    );
    await action(
      "order.cancel",
      {
        id: order.id,
        scope: "items",
        itemIndexes: [0],
        expectedVersion: 1,
        reason: "Wrong item",
      },
      409,
    );
    await action("staff.save", {
      name: "Test kitchen",
      username: "testkitchen",
      password: "kitchen123456",
      managerPassword: "123456789012",
      role: "kitchen",
      salary: 0,
      active: true,
    });
    const kitchenCookie = await login("testkitchen", "kitchen123456");
    const kitchen = await (
      await fetch(base + "/api/state", { headers: { Cookie: kitchenCookie } })
    ).json();
    assert.equal(
      kitchen.orders.filter((o) => o.status === "cancelled").length,
      1,
    );
    assert.equal(
      kitchen.orders.find((o) => o.status === "cancelled").items[0].price,
      undefined,
    );
    const active = state.orders.filter(
      (o) => !o.paid && o.status !== "cancelled",
    );
    state = await action("order.cancel", {
      id: order.id,
      scope: "table",
      expectedVersions: Object.fromEntries(
        active.map((o) => [o.id, o.version]),
      ),
      reason: "Guest left",
    });
    assert.equal(state.tables.find((t) => t.n === 1).status, "available");
    assert.ok(state.orders.every((o) => o.status === "cancelled"));
  } finally {
    server.kill();
  }
});
