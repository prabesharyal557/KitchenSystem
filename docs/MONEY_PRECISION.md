# Money precision decision

The current deployed schema stores rupee snapshots as SQLite `REAL`. A direct in-place conversion to paisa would touch every historic menu line, order line, payment snapshot, and payroll record, so it is deferred until a separately rehearsed reconciliation migration.

All new bill calculations use the shared `calculateBill` function and round subtotal, ingredient cost, tax, total, and payroll balances to two decimal places. Regression tests cover fractional values. Historic payment snapshots remain immutable.

A future paisa migration should add parallel integer columns, backfill with `ROUND(value * 100)`, reconcile row totals and reports in staging, dual-read for one release, then switch writes. Old `REAL` columns must remain until an independently verified backup and financial reconciliation confirm parity.
