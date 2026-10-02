export class CancellationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
type Ticket = {
  id: string;
  table: number;
  paid: boolean;
  status: string;
  version: number;
  items: { id: string; qty: number }[];
  [key: string]: any;
};

export function cancelTickets(
  state: { orders: Ticket[]; tables: { n: number; status: string }[] },
  user: { id: string; role: string },
  payload: any,
  makeId: () => string,
) {
  const fail = (message: string, status = 400): never => {
    throw new CancellationError(message, status);
  };
  if (!["manager", "waiter"].includes(user.role))
    fail("Manager or waiter access required.", 403);
  const source = state.orders.find(
    (o) => o.id === payload.id && !o.paid && o.status !== "cancelled",
  );
  if (!source) fail("Order cannot be cancelled.");
  const reason =
    typeof payload.reason === "string" ? payload.reason.trim() : "";
  if (reason.length < 3 || reason.length > 300)
    fail("Cancellation reason must contain 3–300 characters.");
  const targets =
    payload.scope === "table"
      ? state.orders.filter(
          (o) =>
            o.table === source!.table && !o.paid && o.status !== "cancelled",
        )
      : [source!];
  if (payload.scope && !["table", "items", "order"].includes(payload.scope))
    fail("Invalid cancellation scope.");
  if (
    payload.scope === "table" &&
    Object.keys(payload.expectedVersions || {}).length !== targets.length
  )
    fail("Table orders changed. Refresh before trying again.", 409);
  for (const order of targets) {
    if (!["new", "preparing", "ready", "served"].includes(order.status))
      fail("Order cannot be cancelled.");
    const expected =
      payload.scope === "table"
        ? payload.expectedVersions?.[order.id]
        : payload.expectedVersion;
    if (expected !== undefined && expected !== order.version)
      fail(
        "This order changed on another device. Refresh before trying again.",
        409,
      );
    if (payload.scope === "table" && expected === undefined)
      fail("Table orders changed. Refresh before trying again.", 409);
  }
  const indexes: number[] =
    payload.scope === "items"
      ? payload.itemIndexes
      : source!.items.map((_, i) => i);
  if (
    payload.scope === "items" &&
    (!Array.isArray(indexes) ||
      !indexes.length ||
      new Set(indexes).size !== indexes.length ||
      indexes.some(
        (i) => !Number.isInteger(i) || i < 0 || i >= source!.items.length,
      ))
  )
    fail("Select valid items to cancel.");
  const quantities = new Map<number, number>();
  if (payload.scope === "items") {
    for (const index of indexes) {
      const qty =
        payload.itemQuantities === undefined
          ? source!.items[index].qty
          : payload.itemQuantities?.[index];
      if (!Number.isInteger(qty) || qty < 1 || qty > source!.items[index].qty)
        fail(
          "Cancellation quantity must be between 1 and the ordered quantity.",
        );
      quantities.set(index, qty);
    }
  }
  const time = new Date().toISOString();
  for (const order of targets) {
    const selected =
      payload.scope === "items"
        ? order.items.flatMap((item, i) =>
            quantities.has(i) ? [{ ...item, qty: quantities.get(i)! }] : [],
          )
        : order.items;
    const remaining =
      payload.scope === "items"
        ? order.items.flatMap((item, i) => {
            const qty = item.qty - (quantities.get(i) || 0);
            return qty > 0 ? [{ ...item, qty }] : [];
          })
        : [];
    const cancelled = remaining.length
      ? { ...order, id: makeId(), items: selected, version: 1 }
      : order;
    cancelled.status = "cancelled";
    cancelled.updatedAt = time;
    cancelled.cancelledAt = time;
    cancelled.cancelledById = user.id;
    cancelled.cancellationReason = reason;
    if (remaining.length) {
      order.items = remaining;
      order.version += 1;
      order.updatedAt = time;
      state.orders.push(cancelled);
    } else order.version += 1;
  }
  const table = state.tables.find((t) => t.n === source!.table);
  if (
    table &&
    !state.orders.some(
      (o) => o.table === source!.table && !o.paid && o.status !== "cancelled",
    )
  )
    table.status = "available";
}
