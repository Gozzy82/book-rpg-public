import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAsUser } from "../src/auth/user-context.js";

test("free members receive five successful turns and unlimited grants bypass the quota", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bookrpg-members-"));
  process.env.BOOKRPG_DATA_DIR = directory;
  process.env.BOOKRPG_STORAGE_MODE = "local";
  process.env.BOOKRPG_MEMBER_STORAGE_MODE = "local";
  process.env.BOOKRPG_FREE_TURN_LIMIT = "5";

  try {
    const {
      TurnLimitReachedError,
      commitMemberTurn,
      getCurrentMembership,
      releaseMemberTurn,
      reserveMemberTurn,
      setMemberPlanForEmail,
    } = await import("../src/members/service.js");

    const user = {
      userId: "member-test-user",
      displayName: "Reader",
      provider: "aad",
      email: "reader@example.test",
    };

    await runAsUser(user, async () => {
      assert.deepEqual(await getCurrentMembership(), {
        plan: "free",
        turnLimit: 5,
        turnsUsed: 0,
        turnsRemaining: 5,
      });

      const failedTurn = await reserveMemberTurn();
      assert.equal((await getCurrentMembership()).turnsRemaining, 4);
      await releaseMemberTurn(failedTurn);
      assert.equal((await getCurrentMembership()).turnsRemaining, 5);

      for (let index = 0; index < 5; index++) {
        const reservation = await reserveMemberTurn();
        await commitMemberTurn(reservation);
      }

      assert.deepEqual(await getCurrentMembership(), {
        plan: "free",
        turnLimit: 5,
        turnsUsed: 5,
        turnsRemaining: 0,
      });
      await assert.rejects(
        () => reserveMemberTurn(),
        (error: unknown) => error instanceof TurnLimitReachedError,
      );
    });

    await setMemberPlanForEmail("READER@example.test", "unlimited");

    await runAsUser(user, async () => {
      assert.deepEqual(await getCurrentMembership(), {
        plan: "unlimited",
        turnLimit: null,
        turnsUsed: 5,
        turnsRemaining: null,
      });
      const reservation = await reserveMemberTurn();
      assert.equal(reservation.unlimited, true);
      await commitMemberTurn(reservation);
      assert.equal((await getCurrentMembership()).turnsUsed, 5);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
