import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { recoverManager, recoveryHash, verifyManagerRecoveryCode } from "../manager-recovery.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY, must_change_password INTEGER); CREATE TABLE credentials(id TEXT PRIMARY KEY, hash TEXT); CREATE TABLE sessions(token TEXT PRIMARY KEY, staffId TEXT); CREATE TABLE manager_recovery(staff_id TEXT PRIMARY KEY, hash TEXT, expires INTEGER); INSERT INTO users VALUES('manager',1),('waiter',0); INSERT INTO credentials VALUES('manager','old-manager'),('waiter','unchanged-staff'); INSERT INTO sessions VALUES('manager-session','manager'),('staff-session','waiter');",
  );
  db.prepare("INSERT INTO manager_recovery VALUES(?,?,?)").run(
    "manager",
    recoveryHash("test-recovery-code"),
    Date.now() + 60000,
  );
  function prepare(sql, args = []) {
    return {
      sql,
      args,
      bind(...values) {
        return prepare(sql, values);
      },
      async first() {
        return db.prepare(sql).get(...args);
      },
    };
  }
  const adapter = {
    prepare,
    async batch(statements) {
      db.exec("BEGIN");
      try {
        for (const { sql, args } of statements) db.prepare(sql).run(...args);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {
    db,
    adapter,
    staff: { id: "manager", role: "manager", active: true },
    payload: {
      code: "test-recovery-code",
      newPassword: "new-manager-password",
      confirmPassword: "new-manager-password",
      newRecoveryCode: "private-recovery-code-2026",
    },
  };
}
test("recovery changes only the manager, revokes their sessions, and consumes the old code", async () => {
  const f = fixture();
  try {
    assert.equal(await recoverManager(f.adapter, f.staff, f.payload), true);
    assert.equal(await recoverManager(f.adapter, f.staff, f.payload), false);
    assert.equal(
      f.db.prepare("SELECT hash FROM credentials WHERE id='waiter'").get().hash,
      "unchanged-staff",
    );
    assert.equal(
      f.db
        .prepare("SELECT count(*) n FROM sessions WHERE staffId='manager'")
        .get().n,
      0,
    );
    assert.equal(
      f.db
        .prepare("SELECT count(*) n FROM sessions WHERE staffId='waiter'")
        .get().n,
      1,
    );
    assert.equal(
      f.db
        .prepare("SELECT must_change_password FROM users WHERE id='manager'")
        .get().must_change_password,
      0,
    );
    assert.equal(
      await recoverManager(f.adapter, f.staff, {
        ...f.payload,
        code: f.payload.newRecoveryCode,
        newRecoveryCode: "another-private-recovery-code",
      }),
      true,
    );
  } finally {
    f.db.close();
  }
});
test("staff, suspended managers, wrong codes, and expired codes cannot recover", async () => {
  const f = fixture();
  try {
    for (const staff of [
      { ...f.staff, role: "waiter" },
      { ...f.staff, active: false },
      undefined,
    ])
      assert.equal(await recoverManager(f.adapter, staff, f.payload), false);
    assert.equal(
      await recoverManager(f.adapter, f.staff, {
        ...f.payload,
        code: "incorrect",
      }),
      false,
    );
    f.db.exec("UPDATE manager_recovery SET expires=0");
    assert.equal(await recoverManager(f.adapter, f.staff, f.payload), false);
    assert.equal(
      f.db.prepare("SELECT hash FROM credentials WHERE id='manager'").get()
        .hash,
      "old-manager",
    );
  } finally {
    f.db.close();
  }
});
test("invalid replacement credentials do not consume a valid recovery code", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      recoverManager(f.adapter, f.staff, {
        ...f.payload,
        confirmPassword: "different",
      }),
    );
    await assert.rejects(
      recoverManager(f.adapter, f.staff, {
        ...f.payload,
        newRecoveryCode: "short",
      }),
    );
    assert.equal(await recoverManager(f.adapter, f.staff, f.payload), true);
  } finally {
    f.db.close();
  }
});

test("code verification changes no password and only identifies an active manager", async () => {
  const f = fixture();
  const manager = { ...f.staff, username: "manager" };
  try {
    assert.equal(await verifyManagerRecoveryCode(f.adapter, [manager], "wrong"), undefined);
    assert.equal(await verifyManagerRecoveryCode(f.adapter, [{ ...manager, role: "waiter" }], f.payload.code), undefined);
    assert.equal(await verifyManagerRecoveryCode(f.adapter, [{ ...manager, active: false }], f.payload.code), undefined);
    assert.equal(await verifyManagerRecoveryCode(f.adapter, [manager], f.payload.code), manager);
    assert.equal(f.db.prepare("SELECT hash FROM credentials WHERE id='manager'").get().hash, "old-manager");
    assert.equal(await recoverManager(f.adapter, f.staff, f.payload), true);
    assert.equal(await verifyManagerRecoveryCode(f.adapter, [manager], f.payload.code), undefined);
  } finally { f.db.close(); }
});
