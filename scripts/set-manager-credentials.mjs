import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const [databasePath, newUsername, newPassword, sqlOutput] = process.argv.slice(2);
if (!databasePath || !newUsername || !newPassword || !sqlOutput) {
  throw new Error("Usage: node scripts/set-manager-credentials.mjs <database> <username> <password> <sql-output>");
}

const db = new DatabaseSync(databasePath);
const row = db.prepare("SELECT body FROM state WHERE id=1").get();
if (!row) throw new Error("Restaurant state was not found.");
const state = JSON.parse(row.body);
const manager = state.staff.find((staff) => staff.role === "manager" && staff.active);
if (!manager) throw new Error("An active manager account was not found.");
manager.name = "Prabesh";
manager.username = newUsername.toLowerCase();
const salt = randomBytes(16).toString("hex");
const passwordHash = `${salt}:${scryptSync(newPassword, salt, 64).toString("hex")}`;

db.exec("BEGIN IMMEDIATE");
try {
  db.prepare("UPDATE state SET body=? WHERE id=1").run(JSON.stringify(state));
  db.prepare("INSERT OR REPLACE INTO credentials (id, hash) VALUES (?, ?)").run(manager.id, passwordHash);
  db.prepare("DELETE FROM sessions WHERE staffId=?").run(manager.id);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
writeFileSync(
  sqlOutput,
  [
    `UPDATE state SET body=${quote(JSON.stringify(state))} WHERE id=1;`,
    `INSERT INTO credentials (id, hash) VALUES (${quote(manager.id)}, ${quote(passwordHash)}) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash;`,
    `DELETE FROM sessions WHERE staffId=${quote(manager.id)};`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
console.log(`Updated manager account ${manager.id}.`);
