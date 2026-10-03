import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function recoveryHash(value: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(value, salt, 64).toString("hex")}`;
}
function matches(value: string, hash: string) {
  const [salt, stored] = hash.split(":");
  if (!salt || !stored) return false;
  const actual = scryptSync(value, salt, 64);
  const expected = Buffer.from(stored, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function recoverManager(
  database: D1Database,
  staff: { id: string; role: string; active: boolean } | undefined,
  payload: Record<string, unknown>,
) {
  if (!staff || staff.role !== "manager" || !staff.active) return false;
  const code = typeof payload.code === "string" ? payload.code.trim() : "";
  if (!code || code.length > 128) return false;
  const recovery = await database
    .prepare("SELECT hash, expires FROM manager_recovery WHERE staff_id = ?")
    .bind(staff.id)
    .first<{ hash: string; expires: number }>();
  if (
    !recovery ||
    recovery.expires < Date.now() ||
    !matches(code, recovery.hash)
  )
    return false;
  const pass = payload.newPassword;
  const nextCode = payload.newRecoveryCode;
  if (
    typeof pass !== "string" ||
    pass.length < 12 ||
    pass.length > 128 ||
    pass !== payload.confirmPassword
  )
    throw new Error("Enter matching passwords with 12–128 characters.");
  if (
    typeof nextCode !== "string" ||
    nextCode.trim().length < 16 ||
    nextCode.length > 128 ||
    nextCode.trim() === code
  )
    throw new Error("Choose a different recovery code with 16–128 characters.");
  // The caller serializes requests through the restaurant Durable Object.
  await database.batch([
    database
      .prepare(
        "INSERT INTO credentials (id, hash) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash",
      )
      .bind(staff.id, recoveryHash(pass)),
    database
      .prepare("UPDATE manager_recovery SET hash=?, expires=? WHERE staff_id=?")
      .bind(
        recoveryHash(nextCode.trim()),
        Date.now() + 365 * 86400000,
        staff.id,
      ),
    database
      .prepare("UPDATE users SET must_change_password=0 WHERE id=?")
      .bind(staff.id),
    database.prepare("DELETE FROM sessions WHERE staffId=?").bind(staff.id),
  ]);
  return true;
}
