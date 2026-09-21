import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  authenticatedUser,
  AuthenticationRequiredError,
  runAsUser,
} from "../src/auth/user-context.js";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bookrpg-local-unlimited-"));
const settings = {
  BOOKRPG_DATA_DIR: directory,
  BOOKRPG_STORAGE_MODE: "local",
  BOOKRPG_MEMBER_STORAGE_MODE: "local",
  BOOKRPG_AUTH_MODE: "local",
  BOOKRPG_FREE_TURN_LIMIT: "5",
};
const previousSettings = new Map(Object.keys(settings).map(key => [key, process.env[key]]));
Object.assign(process.env, settings);
const {
  TurnLimitReachedError,
  commitMemberTurn,
  getCurrentMembership,
  releaseMemberTurn,
  reserveMemberTurn,
} = await import("../src/members/service.js");

after(async () => {
  await fs.rm(directory, { recursive: true, force: true });
  for (const [key, value] of previousSettings) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const unlimited = { plan: "unlimited", turnLimit: null, turnsUsed: 0, turnsRemaining: null };
const local = authenticatedUser({ host: "127.0.0.1:3000" });
const localFile = path.join(directory, "members", "local-development.json");
const exhausted = JSON.stringify({
  kind: "member", id: local.userId, userId: local.userId, displayName: local.displayName,
  provider: "local", plan: "free", turnLimit: 5, turnsUsed: 5,
  reservations: [{ id: "legacy-reservation", expiresAt: "2099-01-01T00:00:00.000Z" }],
  createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z",
});

async function withLocalDocument(text: string, operation: () => Promise<void>): Promise<void> {
  await fs.mkdir(path.dirname(localFile), { recursive: true });
  await fs.writeFile(localFile, text, "utf8");
  try {
    await runAsUser(local, operation);
    assert.equal(await fs.readFile(localFile, "utf8"), text, "Local quota storage must stay untouched");
  } finally {
    await fs.rm(localFile, { force: true });
  }
}

function hostedUser(provider = "aad", subject = "hosted-reader", host = "localhost:3000") {
  return authenticatedUser({
    host,
    "x-forwarded-host": "127.0.0.1:3000",
    "x-forwarded-for": "127.0.0.1",
    "x-ms-client-principal": Buffer.from(JSON.stringify({
      auth_typ: provider, userId: subject, userDetails: "reader@example.test",
      userRoles: ["authenticated"],
    })).toString("base64"),
  }, "azure");
}

test("local localhost, IPv4 and IPv6 players remain unlimited even when the configured quota is zero", async () => {
  process.env.BOOKRPG_FREE_TURN_LIMIT = "0";
  try {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
      await runAsUser(authenticatedUser({ host }), async () => {
        assert.deepEqual(await getCurrentMembership(), unlimited);
        for (let turn = 0; turn < 12; turn++) {
          const reservation = await reserveMemberTurn();
          assert.deepEqual(reservation, { id: "", unlimited: true });
          await commitMemberTurn(reservation);
          await releaseMemberTurn(reservation);
        }
        assert.deepEqual(await getCurrentMembership(), unlimited);
      });
    }
    assert.deepEqual(await fs.readdir(directory), [], "Local play must not create member documents");
  } finally {
    process.env.BOOKRPG_FREE_TURN_LIMIT = "5";
  }
});

test("an already exhausted local account needs no reset, migration or unlimited grant", async () => {
  await withLocalDocument(exhausted, async () => {
    assert.deepEqual(await getCurrentMembership(), unlimited);
    const reservation = await reserveMemberTurn();
    assert.equal(reservation.unlimited, true);
    await commitMemberTurn(reservation);
    assert.deepEqual(await getCurrentMembership(), unlimited);
  });
});

test("legacy local reservations cannot write quota counters on commit or release", async () => {
  await withLocalDocument(exhausted, async () => {
    const legacy = { id: "legacy-reservation", unlimited: false };
    await commitMemberTurn(legacy);
    await releaseMemberTurn(legacy);
    assert.deepEqual(await getCurrentMembership(), unlimited);
  });
});

test("local membership and turns do not read even an invalid old member document", async () => {
  await withLocalDocument("invalid old local member JSON", async () => {
    assert.deepEqual(await getCurrentMembership(), unlimited);
    await commitMemberTurn(await reserveMemberTurn());
  });
});

test("concurrent local and hosted requests keep independent allowance decisions", async () => {
  const hosted = hostedUser("aad", "concurrent-reader");
  const localRequests = Array.from({ length: 16 }, () => runAsUser(local, async () => {
    assert.deepEqual(await getCurrentMembership(), unlimited);
    const reservation = await reserveMemberTurn();
    assert.equal(reservation.unlimited, true);
    await commitMemberTurn(reservation);
  }));
  await Promise.all([...localRequests, runAsUser(hosted, async () => {
    for (let turn = 0; turn < 5; turn++) await commitMemberTurn(await reserveMemberTurn());
    assert.equal((await getCurrentMembership()).turnsRemaining, 0);
    await assert.rejects(reserveMemberTurn, TurnLimitReachedError);
  })]);
});

test("loopback headers and even a local-named Azure principal cannot bypass hosted authentication or quotas", async () => {
  for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
    assert.throws(() => authenticatedUser({ host }, "azure"), AuthenticationRequiredError);
  }
  for (const provider of ["aad", "local"]) {
    const hosted = hostedUser(provider, "local-development");
    assert.notEqual(hosted.userId, local.userId);
    await runAsUser(hosted, async () => {
      assert.deepEqual(await getCurrentMembership(), {
        plan: "free", turnLimit: 5, turnsUsed: 0, turnsRemaining: 5,
      });
      for (let turn = 0; turn < 5; turn++) await commitMemberTurn(await reserveMemberTurn());
      await assert.rejects(reserveMemberTurn, (error: unknown) =>
        error instanceof TurnLimitReachedError && error.status === 429 && error.code === "TURN_LIMIT_REACHED");
    });
  }
});

test("both the reserved local user ID and provider are required for the exemption", async () => {
  const nonLocalUsers = [
    { ...local, provider: "aad" },
    { ...local, userId: "other-local-named-user" },
  ];
  try {
    for (const user of nonLocalUsers) {
      await runAsUser(user, async () => {
        assert.equal((await getCurrentMembership()).plan, "free");
        const reservation = await reserveMemberTurn();
        assert.equal(reservation.unlimited, false);
        await releaseMemberTurn(reservation);
      });
    }
  } finally {
    await fs.rm(localFile, { force: true });
  }
});

test("a missing server user context never silently becomes unlimited local access", async () => {
  await assert.rejects(getCurrentMembership, /No authenticated user context/);
  await assert.rejects(reserveMemberTurn, /No authenticated user context/);
});
