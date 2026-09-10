import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  AuthenticationRequiredError,
  authenticatedUser,
  currentUser,
  runAsUser,
} from "../src/auth/user-context.js";

function encodedPrincipal(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

test("local authentication uses an explicit development identity", () => {
  assert.deepEqual(authenticatedUser({}, "local"), {
    userId: "local-development",
    displayName: "Local player",
    provider: "local",
  });
});

test("Azure authentication derives a stable opaque owner from the trusted principal", () => {
  const user = authenticatedUser({
    "x-ms-client-principal": encodedPrincipal({
      identityProvider: "github",
      userId: "github-subject-123",
      userDetails: "reader@example.test",
      userRoles: ["anonymous", "authenticated"],
    }),
  }, "azure");

  assert.deepEqual(user, {
    userId: crypto.createHash("sha256")
      .update("github:github-subject-123")
      .digest("hex"),
    displayName: "reader@example.test",
    provider: "github",
  });
});

test("Azure authentication rejects missing, malformed, and anonymous principals", () => {
  assert.throws(
    () => authenticatedUser({}, "azure"),
    AuthenticationRequiredError,
  );
  assert.throws(
    () => authenticatedUser({ "x-ms-client-principal": "not-base64-json" }, "azure"),
    AuthenticationRequiredError,
  );
  assert.throws(
    () => authenticatedUser({
      "x-ms-client-principal": encodedPrincipal({
        identityProvider: "aad",
        userId: "subject",
        userRoles: ["anonymous"],
      }),
    }, "azure"),
    AuthenticationRequiredError,
  );
});

test("request user context is available only inside its asynchronous operation", async () => {
  const user = authenticatedUser({}, "local");
  await runAsUser(user, async () => {
    await Promise.resolve();
    assert.equal(currentUser(), user);
  });
  assert.throws(() => currentUser(), /No authenticated user context/);
});
