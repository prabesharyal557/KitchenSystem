import test from "node:test";
import assert from "node:assert/strict";
import { cancelTickets } from "../cancellation.ts";
import { calculateBill } from "../domain.ts";

const manager = { id: "manager", role: "manager" };
const fixture = () => ({
  tables: [{ n: 1, status: "occupied" }],
  orders: [
    {
      id: "one",
      table: 1,
      paid: false,
      status: "new",
      version: 1,
      items: [
        { id: "a", name: "Momo", price: 100, cost: 20, qty: 2 },
        { id: "b", name: "Tea", price: 50, cost: 10, qty: 1 },
      ],
    },
    {
      id: "two",
      table: 1,
      paid: false,
      status: "ready",
      version: 2,
      items: [{ id: "b", name: "Tea", price: 50, cost: 10, qty: 1 }],
    },
  ],
});
const payload = { id: "one", reason: "Ordered by mistake", expectedVersion: 1 };

test("partial cancellation retains active items, correct bill, and kitchen history", () => {
  const state = fixture();
  cancelTickets(
    state,
    manager,
    { ...payload, scope: "items", itemIndexes: [0] },
    () => "cancelled-one",
  );
  assert.deepEqual(
    state.orders[0].items.map((i) => i.id),
    ["b"],
  );
  assert.equal(state.orders[0].version, 2);
  assert.equal(state.orders[0].status, "new");
  assert.equal(state.orders[2].status, "cancelled");
  assert.equal(state.orders[2].items[0].qty, 2);
  assert.equal(state.orders[2].cancelledById, manager.id);
  assert.equal(
    calculateBill(
      state.orders
        .filter((o) => o.status !== "cancelled")
        .flatMap((o) => o.items),
      0,
    ).total,
    100,
  );
  assert.equal(state.tables[0].status, "occupied");
});
test("whole table cancellation cancels all unpaid tickets and releases table", () => {
  const state = fixture();
  cancelTickets(
    state,
    manager,
    { ...payload, scope: "table", expectedVersions: { one: 1, two: 2 } },
    () => "unused",
  );
  assert.ok(state.orders.every((o) => o.status === "cancelled"));
  assert.equal(state.tables[0].status, "available");
});
test("waiter cannot partially cancel ready food or partially cancel a table with ready food", () => {
  const state = fixture(),
    before = structuredClone(state);
  assert.throws(
    () =>
      cancelTickets(
        state,
        { id: "waiter", role: "waiter" },
        { ...payload, scope: "table", expectedVersions: { one: 1, two: 2 } },
        () => "unused",
      ),
    { status: 403 },
  );
  assert.deepEqual(state, before);
});
test("stale table snapshot is rejected atomically", () => {
  const state = fixture(),
    before = structuredClone(state);
  assert.throws(
    () =>
      cancelTickets(
        state,
        manager,
        { ...payload, scope: "table", expectedVersions: { one: 1, two: 1 } },
        () => "unused",
      ),
    { status: 409 },
  );
  assert.deepEqual(state, before);
});
test("invalid, duplicate, or empty selection cannot cancel food", () => {
  for (const itemIndexes of [[], [8], [0, 0], [-1], [0.5]]) {
    const state = fixture(),
      before = structuredClone(state);
    assert.throws(() =>
      cancelTickets(
        state,
        manager,
        { ...payload, scope: "items", itemIndexes },
        () => "unused",
      ),
    );
    assert.deepEqual(state, before);
  }
});
test("cancelling all selected items closes the original ticket", () => {
  const state = fixture();
  cancelTickets(
    state,
    manager,
    { ...payload, scope: "items", itemIndexes: [0, 1] },
    () => "unused",
  );
  assert.equal(state.orders.length, 2);
  assert.equal(state.orders[0].status, "cancelled");
});
test("paid tickets, kitchen users, and stale item versions are rejected", () => {
  const state = fixture();
  assert.throws(
    () =>
      cancelTickets(
        state,
        { id: "k", role: "kitchen" },
        payload,
        () => "unused",
      ),
    { status: 403 },
  );
  assert.throws(
    () =>
      cancelTickets(
        state,
        manager,
        { ...payload, expectedVersion: 2 },
        () => "unused",
      ),
    { status: 409 },
  );
  state.orders[0].paid = true;
  assert.throws(() => cancelTickets(state, manager, payload, () => "unused"));
});
