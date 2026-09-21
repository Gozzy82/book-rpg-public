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
    email: "reader@example.test",
  });
});

test("Azure authentication reads an email claim from EasyAuth", () => {
  const user = authenticatedUser({
    "x-ms-client-principal": encodedPrincipal({
      identityProvider: "aad",
      userId: "external-id-subject",
      userDetails: "Reader",
      userRoles: ["authenticated"],
      claims: [
        { typ: "email", val: "reader@example.test" },
      ],
    }),
  }, "azure");

  assert.equal(user.email, "reader@example.test");
  assert.equal(user.displayName, "Reader");
});

test("Azure Container Apps EasyAuth accepts claims-based principals and identity headers", () => {
  const user = authenticatedUser({
    "x-ms-client-principal": encodedPrincipal({
      auth_typ: "aad",
      name_typ: "name",
      role_typ: "roles",
      claims: [
        { typ: "name", val: "External Reader" },
        { typ: "email", val: "reader@example.test" },
        { typ: "http://schemas.microsoft.com/identity/claims/objectidentifier", val: "object-123" },
      ],
    }),
    "x-ms-client-principal-id": "object-123",
    "x-ms-client-principal-name": "reader@example.test",
    "x-ms-client-principal-idp": "aad",
  }, "azure");

  assert.deepEqual(user, {
    userId: crypto.createHash("sha256")
      .update("aad:object-123")
      .digest("hex"),
    displayName: "reader@example.test",
    provider: "aad",
    email: "reader@example.test",
  });
});

test("Azure Container Apps EasyAuth can derive subject and provider from claims payload", () => {
  const user = authenticatedUser({
    "x-ms-client-principal": encodedPrincipal({
      auth_typ: "aad",
      claims: [
        { typ: "sub", val: "external-subject" },
        { typ: "email", val: "reader2@example.test" },
        { typ: "name", val: "Reader Two" },
      ],
    }),
  }, "azure");

  assert.equal(user.provider, "aad");
  assert.equal(user.displayName, "Reader Two");
  assert.equal(user.email, "reader2@example.test");
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

test("hosted member mode rejects authenticated principals without an email", () => {
  const previous = process.env.BOOKRPG_REQUIRE_MEMBER_EMAIL;
  process.env.BOOKRPG_REQUIRE_MEMBER_EMAIL = "1";
  try {
    assert.throws(
      () => authenticatedUser({
        "x-ms-client-principal": encodedPrincipal({
          identityProvider: "aad",
          userId: "subject-without-email",
          userDetails: "Reader",
          userRoles: ["authenticated"],
        }),
      }, "azure"),
      AuthenticationRequiredError,
    );
  } finally {
    if (previous === undefined) delete process.env.BOOKRPG_REQUIRE_MEMBER_EMAIL;
    else process.env.BOOKRPG_REQUIRE_MEMBER_EMAIL = previous;
  }
});

test("request user context is available only inside its asynchronous operation", async () => {
  const user = authenticatedUser({}, "local");
  await runAsUser(user, async () => {
    await Promise.resolve();
    assert.equal(currentUser(), user);
  });
  assert.throws(() => currentUser(), /No authenticated user context/);
});
