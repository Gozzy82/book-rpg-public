import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingHttpHeaders } from "node:http";

export interface AuthenticatedUser {
  userId: string;
  displayName: string;
  provider: string;
}

interface ClientPrincipal {
  identityProvider?: unknown;
  userId?: unknown;
  userDetails?: unknown;
  userRoles?: unknown;
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
  const provider = typeof principal.identityProvider === "string"
    ? principal.identityProvider.trim()
    : "";
  const subject = typeof principal.userId === "string" ? principal.userId.trim() : "";
  const roles = Array.isArray(principal.userRoles)
    ? principal.userRoles.filter((role): role is string => typeof role === "string")
    : [];
  if (!provider || !subject || !roles.includes("authenticated")) {
    throw new AuthenticationRequiredError("The authentication principal is incomplete");
  }

  return {
    userId: crypto.createHash("sha256").update(`${provider}:${subject}`).digest("hex"),
    displayName: typeof principal.userDetails === "string" && principal.userDetails.trim()
      ? principal.userDetails.trim()
      : "BookRPG player",
    provider,
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
