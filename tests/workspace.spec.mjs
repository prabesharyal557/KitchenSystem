import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

let server, dataDir;
test.beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "sajilo-ui-"));
  server = spawn(process.execPath, ["server.ts"], {
    env: { ...process.env, PORT: "3138", DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch("http://127.0.0.1:3138/api/bootstrap");
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("UI test server failed to start");
});
test.afterAll(async () => {
  if (server && server.exitCode === null) {
    server.kill();
    await once(server, "exit");
  }
  rmSync(dataDir, { force: true, recursive: true });
});

test("manager and waiter: live service, reports, payroll, settings and responsive UI", async ({
  page,
  browser,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("dialog", (d) => d.accept());
  await page.goto("/");
  await page.getByLabel("Your name").fill("Anisha Rai");
  await page.getByLabel("Username").fill("anisha");
  await page
    .getByLabel("Password", { exact: true })
    .fill("manager-ui-test-password");
  await page.getByRole("button", { name: "Create manager account" }).click();
  await expect(
    page.getByRole("heading", { name: "Your restaurant, at a glance." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "TOTAL SALES · TODAY" }).click();
  await expect(
    page.getByRole("heading", { name: "Sales & performance" }),
  ).toBeVisible();
  for (const name of ["Week", "Month", "Year", "Day"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("button", { name, exact: true })).toHaveClass(
      "selected",
    );
  }
  await page.getByRole("button", { name: "Tables", exact: true }).click();
  await page.getByRole("button", { name: "+ Add table" }).click();
  await page.getByLabel("Table number").fill("20");
  await page.getByLabel("Seats", { exact: true }).fill("6");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  let table = page.locator("article.table").filter({
    has: page.getByRole("heading", { name: "Table 20", exact: true }),
  });
  await expect(table).toContainText("6 seats");
  await table.getByRole("button", { name: "Manage", exact: true }).click();
  await page.getByLabel("Table status").selectOption("pending");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(table).toContainText("Reserved");
  await table.getByRole("button", { name: "Manage", exact: true }).click();
  await page.getByRole("button", { name: "Delete table" }).click();
  await expect(table).toHaveCount(0);

  await page.getByRole("button", { name: "Food menu", exact: true }).click();
  await page.getByRole("button", { name: "+ Add menu item" }).click();
  await page.getByLabel("Item name").fill("Buff Momo");
  await page.getByLabel("Category (e.g. Momo)").fill("Momo");
  await page.getByLabel("Selling price").fill("200");
  await page.getByLabel("Ingredient cost").fill("80");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByLabel("Category", { exact: true }).selectOption("Momo");
  await page.getByLabel("Sort items").selectOption("price");
  await expect(
    page.locator(".menu-item").filter({ hasText: "Buff Momo" }),
  ).toContainText("Rs. 200.00");

  await page
    .getByRole("button", { name: "Staff & payroll", exact: true })
    .click();
  await page.getByRole("button", { name: "+ Add staff" }).click();
  await page.getByLabel("Full name").fill("Ram Poudel");
  await page.getByLabel("Username").fill("ram");
  await page
    .getByLabel("Password (12+ characters)")
    .fill("waiter-ui-test-password");
  await page.getByLabel("Monthly salary (Rs.)").fill("25000");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const member = page.locator(".staff-card").filter({ hasText: "Ram Poudel" });
  await member.getByRole("button", { name: "Record payment" }).click();
  await page.getByLabel("Amount paid").fill("5000");
  await page.getByLabel("Payment type").selectOption("Advance");
  await page.getByLabel("Note / reference").fill("Mid-month advance");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(member).toContainText("Rs. 20,000.00");
  await expect(
    page.getByText("Mid-month advance", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Tax rate (%)").fill("13");
  await page.getByRole("button", { name: "Save settings" }).click();

  const waiterContext = await browser.newContext();
  const waiter = await waiterContext.newPage();
  waiter.on("dialog", (d) => d.accept());
  await waiter.goto("http://127.0.0.1:3138/");
  await waiter.getByLabel("Username").fill("ram");
  await waiter
    .getByLabel("Password", { exact: true })
    .fill("waiter-ui-test-password");
  await waiter.getByRole("button", { name: "Sign in to workspace" }).click();
  await expect(
    waiter.getByRole("heading", { name: "A place for every guest." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Active orders", exact: true })
    .click();
  await waiter
    .locator("article.table")
    .filter({
      has: waiter.getByRole("heading", { name: "Table 1", exact: true }),
    })
    .getByRole("button", { name: "Open table" })
    .click();
  await waiter.getByRole("button", { name: "Buff Momo Momo" }).click();
  await waiter.getByRole("button", { name: "Send to kitchen" }).click();
  await expect(page.locator(".korder")).toContainText("Buff Momo", {
    timeout: 10000,
  });
  await expect(page.locator(".kanban")).toHaveCount(2);
  await page.screenshot({
    path: testInfo.outputPath("kitchen-board.png"),
    fullPage: true,
  });
  for (const name of ["Mark ready to serve →", "✓ Mark served"])
    await page.getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: "View bill", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Tax (13%)");
  await expect(page.getByRole("dialog")).toContainText("Rs. 226.00");
  let paymentPopups = 0;
  page.on("dialog", () => paymentPopups++);
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await expect(page.locator(".payment-confirm")).toContainText("Rs. 226.00");
  await page.screenshot({
    path: testInfo.outputPath("payment-confirmation.png"),
  });
  await page.getByRole("button", { name: "Back to bill", exact: true }).click();
  await expect(page.locator(".payment-confirm")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm payment", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(paymentPopups).toBe(0);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "TOTAL SALES · TODAY" }),
  ).toContainText("Rs. 226.00");
  await page.screenshot({
    path: testInfo.outputPath("manager-overview.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "COMPLETED SALES" }).click();
  await expect(
    page.getByRole("heading", { name: "Completed sales" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "EST. GROSS PROFIT" }),
  ).toContainText("Rs. 120.00");
  for (const name of ["Week", "Month", "Year"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(
      page.getByRole("button", { name: "TOTAL COLLECTED" }),
    ).toContainText("Rs. 226.00");
  }
  await page.getByLabel("Period containing").fill("2020-01-01");
  await page.getByLabel("Period containing").blur();
  await expect(
    page.getByRole("button", { name: "TOTAL COLLECTED" }),
  ).toContainText("Rs. 0.00");
  await page
    .getByRole("button", { name: "Online orders", exact: false })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your next table could be anywhere." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Restaurant access").selectOption("false");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(waiter).toHaveURL(/message=/, { timeout: 10000 });
  await page.getByLabel("Restaurant access").selectOption("true");
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  for (const name of [
    "Overview",
    "Tables",
    "Food menu",
    "Staff & payroll",
    "Sales reports",
    "Settings",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.screenshot({
    path: testInfo.outputPath("manager-mobile.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
  await waiterContext.close();
});

test("kitchen and waiter receive role-specific alerts without repeated notifications", async ({
  browser,
}) => {
  const managerContext = await browser.newContext();
  const login = await managerContext.request.post(
    "http://127.0.0.1:3138/api/login",
    {
      data: { username: "anisha", password: "manager-ui-test-password" },
    },
  );
  expect(login.ok()).toBe(true);
  async function action(action, payload) {
    const response = await managerContext.request.post(
      "http://127.0.0.1:3138/api/action",
      { data: { action, payload } },
    );
    expect(response.ok()).toBe(true);
    return response.json();
  }
  let state = await action("staff.save", {
    name: "Kitchen Cook",
    username: "cook",
    password: "kitchen-ui-test-password",
    role: "kitchen",
    active: true,
    salary: 30000,
  });
  const kitchenContext = await browser.newContext();
  const waiterContext = await browser.newContext();
  async function staffPage(context, username, password) {
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:3138/");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in to workspace" }).click();
    await expect(
      page.getByRole("button", { name: "Enable sound & desktop alerts" }),
    ).toBeVisible();
    return page;
  }
  const kitchen = await staffPage(
    kitchenContext,
    "cook",
    "kitchen-ui-test-password",
  );
  const waiter = await staffPage(
    waiterContext,
    "ram",
    "waiter-ui-test-password",
  );
  await waiter
    .locator("article.table")
    .filter({
      has: waiter.getByRole("heading", { name: "Table 2", exact: true }),
    })
    .getByRole("button", { name: "Open table" })
    .click();
  await waiter.getByRole("searchbox").fill("Momo");
  const item = state.menu.find((i) => i.name === "Buff Momo");
  state = await action("order.create", {
    table: 2,
    items: [{ id: item.id, qty: 2 }],
  });
  const order = state.orders[0];
  await expect(kitchen.locator(".order-alert")).toContainText(
    "New order received",
    { timeout: 10000 },
  );
  await expect(kitchen.locator(".order-alert")).toContainText("Table 2");
  await expect(kitchen.locator(".order-alert")).toContainText("2× Buff Momo");
  await expect(waiter.locator(".order-alert")).toHaveCount(0);
  await kitchen.reload();
  await expect(
    kitchen.getByRole("heading", { name: "Kitchen orders" }),
  ).toBeVisible();
  await kitchen.waitForResponse((r) => r.url().endsWith("/api/state"));
  await expect(kitchen.locator(".order-alert")).toHaveCount(0);
  await action("order.advance", { id: order.id, status: "new" });
  await expect(waiter.locator(".order-alert")).toContainText(
    "Order ready to serve",
    { timeout: 10000 },
  );
  await expect(waiter.getByRole("searchbox")).toHaveValue("Momo");
  await expect(waiter.getByRole("searchbox")).toBeFocused();
  await expect(kitchen.locator(".order-alert")).toHaveCount(0);
  await waiter.waitForResponse((r) => r.url().endsWith("/api/state"));
  await expect(waiter.locator(".order-alert")).toHaveCount(1);
  await waiter.getByRole("button", { name: "View order", exact: true }).click();
  await expect(
    waiter.getByRole("heading", { name: "Ready to serve", level: 1 }),
  ).toBeVisible();
  await expect(
    waiter.locator(".korder").filter({ hasText: order.id.slice(0, 6) }),
  ).toContainText("Ready");
  await expect(waiter.locator(".order-alert")).toHaveCount(0);
  await waiter.reload();
  await waiter.waitForResponse((r) => r.url().endsWith("/api/state"));
  await expect(waiter.locator(".order-alert")).toHaveCount(0);
  state = await action("order.create", {
    table: 3,
    items: [{ id: item.id, qty: 1 }],
  });
  await expect(kitchen.locator(".order-alert")).toContainText("Table 3", {
    timeout: 10000,
  });
  await action("order.advance", { id: state.orders[0].id, status: "new" });
  await expect(kitchen.locator(".order-alert")).toHaveCount(0, {
    timeout: 10000,
  });
  await Promise.all([
    managerContext.close(),
    kitchenContext.close(),
    waiterContext.close(),
  ]);
});

test("different users work simultaneously in the same browser without replacing each other's login", async ({
  browser,
}) => {
  const context = await browser.newContext();
  async function signIn(username, password, heading) {
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:3138/");
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in to workspace" }).click();
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    return page;
  }
  const manager = await signIn(
    "anisha",
    "manager-ui-test-password",
    "Your restaurant, at a glance.",
  );
  const waiter = await signIn(
    "ram",
    "waiter-ui-test-password",
    "A place for every guest.",
  );
  const kitchen = await signIn(
    "cook",
    "kitchen-ui-test-password",
    "Kitchen orders",
  );
  const secondWaiter = await signIn(
    "ram",
    "waiter-ui-test-password",
    "A place for every guest.",
  );
  await Promise.all([
    manager.reload(),
    waiter.reload(),
    kitchen.reload(),
    secondWaiter.reload(),
  ]);
  await expect(manager.locator(".profile")).toContainText("Anisha Rai");
  await expect(waiter.locator(".profile")).toContainText("Ram Poudel");
  await expect(kitchen.locator(".profile")).toContainText("Kitchen Cook");
  async function prepareOrder(page, table) {
    await page
      .locator("article.table")
      .filter({
        has: page.getByRole("heading", { name: `Table ${table}`, exact: true }),
      })
      .getByRole("button", { name: "Open table" })
      .click();
    await page.getByRole("button", { name: "Buff Momo Momo" }).click();
  }
  await Promise.all([prepareOrder(waiter, 5), prepareOrder(secondWaiter, 6)]);
  await Promise.all([
    waiter.getByRole("button", { name: "Send to kitchen" }).click(),
    secondWaiter.getByRole("button", { name: "Send to kitchen" }).click(),
  ]);
  await expect(
    kitchen.locator(".korder").filter({ hasText: "Table 5" }),
  ).toContainText("Buff Momo", { timeout: 10000 });
  await expect(
    kitchen.locator(".korder").filter({ hasText: "Table 6" }),
  ).toContainText("Buff Momo", { timeout: 10000 });
  await waiter.getByRole("button", { name: "Sign out" }).click();
  await expect(
    waiter.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await Promise.all([
    manager.reload(),
    kitchen.reload(),
    secondWaiter.reload(),
  ]);
  await expect(manager.locator(".profile")).toContainText("Anisha Rai");
  await expect(kitchen.locator(".profile")).toContainText("Kitchen Cook");
  await expect(secondWaiter.locator(".profile")).toContainText("Ram Poudel");
  await context.close();
});
