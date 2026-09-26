import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const source = process.argv[2] || "data/sajilo.sqlite";
const output = process.argv[3] || "d1-export.sql";
const db = new DatabaseSync(resolve(source), { readOnly: true });
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const state = db.prepare("SELECT id, body FROM state ORDER BY id").all();
const credentials = db.prepare("SELECT id, hash FROM credentials ORDER BY id").all();
const sessions = db
  .prepare("SELECT token, staffId, expires FROM sessions WHERE expires > ? ORDER BY token")
  .all(Date.now());

const lines = [
  "-- Generated from the existing SQLite database. Do not commit this file.",
  "BEGIN;",
  ...state.map((row) =>
    `INSERT INTO state (id, body) VALUES (${row.id}, ${quote(row.body)}) ` +
      "ON CONFLICT(id) DO UPDATE SET body=excluded.body;",
  ),
  ...credentials.map((row) =>
    `INSERT INTO credentials (id, hash) VALUES (${quote(row.id)}, ${quote(row.hash)}) ` +
      "ON CONFLICT(id) DO UPDATE SET hash=excluded.hash;",
  ),
  ...sessions.map(
    (row) =>
      `INSERT INTO sessions (token, staffId, expires) VALUES (${quote(row.token)}, ${quote(row.staffId)}, ${row.expires}) ` +
      "ON CONFLICT(token) DO UPDATE SET staffId=excluded.staffId, expires=excluded.expires;",
  ),
  "COMMIT;",
  "",
];

db.close();
writeFileSync(resolve(output), lines.join("\n"), { mode: 0o600 });
console.log(`Exported ${state.length} state row(s), ${credentials.length} credential(s), and ${sessions.length} active session(s) to ${resolve(output)}.`);
