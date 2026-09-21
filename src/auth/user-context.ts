import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingHttpHeaders } from "node:http";

export interface AuthenticatedUser {
  userId: string;
  displayName: string;
  provider: string;
  email?: string;
}

interface ClientPrincipalClaim {
  typ?: unknown;
  val?: unknown;
}

interface ClientPrincipal {
  auth_typ?: unknown;
  name_typ?: unknown;
  role_typ?: unknown;
  identityProvider?: unknown;
  userId?: unknown;
  userDetails?: unknown;
  userRoles?: unknown;
  claims?: unknown;
}

export class AuthenticationRequiredError extends Error {
  readonly status = 401;

  constructor(message = "Authentication is required") {
    super(message);
    this.name = "AuthenticationRequiredError";
  }
}

const userContext = new AsyncLocalStorage<AuthenticatedUser>();

function decodeClientPrincipal(value: string): ClientPrincipal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch (cause) {
    throw new AuthenticationRequiredError(
      cause instanceof Error
        ? `The authentication principal is invalid: ${cause.message}`
        : "The authentication principal is invalid",
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new AuthenticationRequiredError("The authentication principal is invalid");
  }
  return parsed as ClientPrincipal;
}

function claimValue(principal: ClientPrincipal, names: string[]): string | undefined {
  if (!Array.isArray(principal.claims)) return undefined;
  for (const name of names) {
    const wanted = name.toLowerCase();
    for (const rawClaim of principal.claims) {
      if (!rawClaim || typeof rawClaim !== "object") continue;
      const claim = rawClaim as ClientPrincipalClaim;
      if (typeof claim.typ !== "string" || typeof claim.val !== "string") continue;
      if (claim.typ.toLowerCase() !== wanted) continue;
      const value = claim.val.trim();
      if (value) return value;
    }
  }
  return undefined;
}

function emailFromPrincipal(principal: ClientPrincipal): string | undefined {
  const fromClaim = claimValue(principal, [
    "email",
    "emails",
    "preferred_username",
    "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  ]);
  if (fromClaim?.includes("@")) return fromClaim;
  const details = typeof principal.userDetails === "string"
    ? principal.userDetails.trim()
    : "";
  return details.includes("@") ? details : undefined;
}

export function authenticatedUser(
  headers: IncomingHttpHeaders,
  mode = process.env.BOOKRPG_AUTH_MODE?.trim().toLowerCase() || "local",
): AuthenticatedUser {
  if (mode === "local") {
    return {
      userId: "local-development",
      displayName: "Local player",
      provider: "local",
    };
  }
  if (mode !== "azure") {
    throw new Error(`Unsupported BOOKRPG_AUTH_MODE: ${mode}`);
  }

  const encodedPrincipal = headers["x-ms-client-principal"];
  if (typeof encodedPrincipal !== "string" || !encodedPrincipal.trim()) {
    throw new AuthenticationRequiredError();
  }
  const principal = decodeClientPrincipal(encodedPrincipal);
  const providerHeader = headers["x-ms-client-principal-idp"];
  const provider = typeof providerHeader === "string" && providerHeader.trim()
    ? providerHeader.trim()
    : typeof principal.auth_typ === "string" && principal.auth_typ.trim()
      ? principal.auth_typ.trim()
      : typeof principal.identityProvider === "string"
        ? principal.identityProvider.trim()
        : "";

  const subjectHeader = headers["x-ms-client-principal-id"];
  const subject = typeof subjectHeader === "string" && subjectHeader.trim()
    ? subjectHeader.trim()
    : typeof principal.userId === "string" && principal.userId.trim()
      ? principal.userId.trim()
      : claimValue(principal, [
          "oid",
          "sub",
          "http://schemas.microsoft.com/identity/claims/objectidentifier",
          "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
        ]) || "";

  const roles = Array.isArray(principal.userRoles)
    ? principal.userRoles.filter((role): role is string => typeof role === "string")
    : undefined;
  if (
    !provider
    || !subject
    || (roles !== undefined && !roles.includes("authenticated"))
  ) {
    throw new AuthenticationRequiredError("The authentication principal is incomplete");
  }

  const principalNameHeader = headers["x-ms-client-principal-name"];
  const principalName = typeof principalNameHeader === "string" && principalNameHeader.trim()
    ? principalNameHeader.trim()
    : undefined;
  const email = emailFromPrincipal(principal)
    || (principalName?.includes("@") ? principalName : undefined);
  if (process.env.BOOKRPG_REQUIRE_MEMBER_EMAIL === "1" && !email) {
    throw new AuthenticationRequiredError("An email address is required for a BookRPG account");
  }

  const displayName = principalName
    || (typeof principal.userDetails === "string" && principal.userDetails.trim()
      ? principal.userDetails.trim()
      : claimValue(principal, [
          "name",
          "preferred_username",
          "email",
          "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
        ]))
    || "BookRPG player";

  return {
    userId: crypto.createHash("sha256").update(`${provider}:${subject}`).digest("hex"),
    displayName,
    provider,
    ...(email ? { email } : {}),
  };
}

export function runAsUser<T>(
  user: AuthenticatedUser,
  operation: () => Promise<T>,
): Promise<T> {
  return userContext.run(user, operation);
}

export function currentUser(): AuthenticatedUser {
  const user = userContext.getStore();
  if (!user) throw new Error("No authenticated user context is active");
  return user;
}
