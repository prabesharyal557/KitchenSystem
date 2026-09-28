import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const database = process.argv[2] || "sajilo-restaurant";
const output = resolve(
  process.argv[3] ||
    `backups/${database}-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`,
);
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");

function query(sql) {
  const raw = execFileSync(
    process.execPath,
    [
      wrangler,
      "d1",
      "execute",
      database,
      "--remote",
      "--json",
      "--command",
      sql,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const result = JSON.parse(raw);
  if (!result[0]?.success) throw new Error(`D1 query failed: ${sql}`);
  return result[0].results;
}

function identifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Cannot export non-finite number");
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

const schema = query(
  "SELECT type, name, tbl_name, sql FROM sqlite_master " +
    "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV' " +
    "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name",
);
const tables = schema.filter((entry) => entry.type === "table");
const lines = [
  "-- Sajilo D1 logical backup",
  `-- Database: ${database}`,
  `-- Created: ${new Date().toISOString()}`,
  "PRAGMA foreign_keys=OFF;",
  "BEGIN TRANSACTION;",
];
const counts = {};

for (const entry of tables) lines.push(`${entry.sql};`);
for (const entry of tables) {
  const rows = query(`SELECT * FROM ${identifier(entry.name)}`);
  counts[entry.name] = rows.length;
  for (const row of rows) {
    const columns = Object.keys(row);
    lines.push(
      `INSERT INTO ${identifier(entry.name)} (${columns.map(identifier).join(", ")}) VALUES (${columns.map((column) => literal(row[column])).join(", ")});`,
    );
  }
}
for (const entry of schema.filter((entry) => entry.type === "index"))
  lines.push(`${entry.sql};`);
lines.push("COMMIT;", "PRAGMA foreign_keys=ON;", "");

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, lines.join("\n"), { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ database, output, tables: counts }));
