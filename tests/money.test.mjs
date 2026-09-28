import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateBill, roundMoney } from "../domain.ts";

test("money totals use consistent two-decimal NPR rounding", () => {
  assert.equal(roundMoney(1.005), 1.01);
  assert.deepEqual(
    calculateBill(
      [
        { price: 0.1, cost: 0.03, qty: 3 },
        { price: 125.5, cost: 80.125, qty: 2 },
      ],
      13,
    ),
    { subtotal: 251.3, cost: 160.34, tax: 32.67, total: 283.97 },
  );
});
