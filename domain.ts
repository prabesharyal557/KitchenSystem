export type PricedLine = {
  price: number;
  cost: number;
  qty: number;
};

export const roundMoney = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

export function calculateBill(lines: PricedLine[], taxRate: number) {
  const subtotal = roundMoney(
    lines.reduce((sum, line) => sum + line.price * line.qty, 0),
  );
  const cost = roundMoney(
    lines.reduce((sum, line) => sum + line.cost * line.qty, 0),
  );
  const tax = roundMoney((subtotal * taxRate) / 100);
  return { subtotal, cost, tax, total: roundMoney(subtotal + tax) };
}
