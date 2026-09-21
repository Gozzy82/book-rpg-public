import crypto from "node:crypto";
import path from "node:path";
import { CosmosClient } from "@azure/cosmos";
import { azureCredential } from "../azure/credential.js";
import type { AuthenticatedUser } from "../auth/user-context.js";
import { currentUser } from "../auth/user-context.js";
import { dataDir } from "../util/env.js";
import { withFileLock } from "../util/file-lock.js";
import { JsonFileStore } from "../util/json-file-store.js";

export type MemberPlan = "free" | "unlimited";

interface MemberTurnReservation {
  id: string;
  expiresAt: string;
}

interface MemberDocument {
  kind: "member";
  id: string;
  userId: string;
  email?: string;
  emailNormalized?: string;
  displayName: string;
  provider: string;
  plan: MemberPlan;
  turnLimit: number | null;
  turnsUsed: number;
  reservations: MemberTurnReservation[];
  createdAt: string;
  updatedAt: string;
}

interface MemberGrantDocument {
  kind: "grant";
  id: string;
  userId: string;
  email: string;
  emailNormalized: string;
  plan: MemberPlan;
  createdAt: string;
  updatedAt: string;
}

type StoredMemberDocument = MemberDocument | MemberGrantDocument;

type CosmosStoredMemberDocument = StoredMemberDocument & {
  _etag?: string;
};

interface MemberDocumentStore {
  get(id: string): Promise<StoredMemberDocument | undefined>;
  change(
    id: string,
    update: (current: StoredMemberDocument | undefined) => StoredMemberDocument,
  ): Promise<StoredMemberDocument>;
  put(document: StoredMemberDocument): Promise<void>;
}

export interface MembershipView {
  plan: MemberPlan;
  turnLimit: number | null;
  turnsUsed: number;
  turnsRemaining: number | null;
}

export interface MemberTurnReservationToken {
  id: string;
  unlimited: boolean;
}

export class TurnLimitReachedError extends Error {
  readonly status = 429;
  readonly code = "TURN_LIMIT_REACHED";

  constructor(readonly membership: MembershipView) {
    super("You have used all of your free BookRPG turns.");
    this.name = "TurnLimitReachedError";
  }
}

function isCosmosNotFound(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && Number((error as { code?: number }).code) === 404,
  );
}

class FileMemberStore implements MemberDocumentStore {
  private readonly directory = path.join(dataDir(), "members");
  private readonly store = new JsonFileStore<StoredMemberDocument>(this.directory);

  async get(id: string): Promise<StoredMemberDocument | undefined> {
    return this.store.get(id);
  }

  async change(
    id: string,
    update: (current: StoredMemberDocument | undefined) => StoredMemberDocument,
  ): Promise<StoredMemberDocument> {
    return withFileLock(path.join(this.directory, `${id}.lock`), async () => {
      const next = update(await this.store.get(id));
      await this.store.put(id, next);
      return next;
    });
  }

  async put(document: StoredMemberDocument): Promise<void> {
    await withFileLock(path.join(this.directory, `${document.id}.lock`), async () => {
      await this.store.put(document.id, document);
    });
  }
}

class CosmosMemberStore implements MemberDocumentStore {
  private readonly container;

  constructor() {
    const endpoint = process.env.COSMOS_ENDPOINT?.trim();
    if (!endpoint) throw new Error("COSMOS_ENDPOINT is required for Azure member storage");
    const databaseName = process.env.COSMOS_DATABASE?.trim() || "bookrpg";
    const containerName = process.env.COSMOS_MEMBERS_CONTAINER?.trim() || "members";
    const client = new CosmosClient({
      endpoint,
      aadCredentials: azureCredential(),
    });
    this.container = client.database(databaseName).container(containerName);
  }

  async get(id: string): Promise<StoredMemberDocument | undefined> {
    try {
      const response = await this.container.item(id, id).read<CosmosStoredMemberDocument>();
      if (!response.resource) return undefined;
      const { _etag: _etag, ...document } = response.resource;
      return document;
    } catch (error) {
      if (isCosmosNotFound(error)) return undefined;
      throw error;
    }
  }

  async change(
    id: string,
    update: (current: StoredMemberDocument | undefined) => StoredMemberDocument,
  ): Promise<StoredMemberDocument> {
    for (let attempt = 0; attempt < 8; attempt++) {
      let current: CosmosStoredMemberDocument | undefined;
      try {
        current = (await this.container.item(id, id).read<CosmosStoredMemberDocument>()).resource;
      } catch (error) {
        if (!isCosmosNotFound(error)) throw error;
      }

      let currentDocument: StoredMemberDocument | undefined;
      if (current) {
        const { _etag: _etag, ...document } = current;
        currentDocument = document;
      }
      const next = update(currentDocument);
      try {
        if (current?._etag) {
          await this.container.item(id, id).replace(next, {
            accessCondition: { type: "IfMatch", condition: current._etag },
          });
        } else {
          await this.container.items.create(next);
        }
        return next;
      } catch (error) {
        if (![409, 412].includes(Number((error as { code?: number }).code))) throw error;
      }
    }
    throw new Error("Concurrent member update; please retry");
  }

  async put(document: StoredMemberDocument): Promise<void> {
    await this.container.items.upsert(document);
  }
}

function createMemberStore(): MemberDocumentStore {
  const mode = (
    process.env.BOOKRPG_MEMBER_STORAGE_MODE
    || process.env.BOOKRPG_STORAGE_MODE
    || "local"
  ).trim().toLowerCase();
  if (mode === "local") return new FileMemberStore();
  if (mode === "azure") return new CosmosMemberStore();
  throw new Error(`Unsupported BOOKRPG_MEMBER_STORAGE_MODE: ${mode}`);
}

const store = createMemberStore();

export function normalizeMemberEmail(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.includes("@") ? normalized : undefined;
}

function grantIdForEmail(email: string): string {
  return `grant_${crypto.createHash("sha256").update(email).digest("hex")}`;
}

function configuredFreeTurnLimit(): number {
  const configured = Number(process.env.BOOKRPG_FREE_TURN_LIMIT || 5);
  return Number.isInteger(configured) && configured >= 0 ? configured : 5;
}

function reservationLifetimeMs(): number {
  const configured = Number(process.env.BOOKRPG_TURN_RESERVATION_MINUTES || 120);
  const minutes = Number.isFinite(configured) && configured > 0 ? configured : 120;
  return minutes * 60_000;
}

function activeReservations(
  reservations: MemberTurnReservation[] | undefined,
  now = Date.now(),
): MemberTurnReservation[] {
  return (reservations ?? []).filter((reservation) => {
    const expiresAt = Date.parse(reservation.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > now;
  });
}

function membershipView(member: MemberDocument, now = Date.now()): MembershipView {
  if (member.plan === "unlimited") {
    return {
      plan: "unlimited",
      turnLimit: null,
      turnsUsed: member.turnsUsed,
      turnsRemaining: null,
    };
  }
  const turnLimit = member.turnLimit ?? configuredFreeTurnLimit();
  const reserved = activeReservations(member.reservations, now).length;
  return {
    plan: "free",
    turnLimit,
    turnsUsed: member.turnsUsed,
    turnsRemaining: Math.max(0, turnLimit - member.turnsUsed - reserved),
  };
}

function newMember(
  user: AuthenticatedUser,
  plan: MemberPlan,
  nowIso: string,
): MemberDocument {
  const emailNormalized = normalizeMemberEmail(user.email);
  return {
    kind: "member",
    id: user.userId,
    userId: user.userId,
    ...(user.email ? { email: user.email } : {}),
    ...(emailNormalized ? { emailNormalized } : {}),
    displayName: user.displayName,
    provider: user.provider,
    plan,
    turnLimit: plan === "unlimited" ? null : configuredFreeTurnLimit(),
    turnsUsed: 0,
    reservations: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function reconcileMember(
  current: StoredMemberDocument | undefined,
  user: AuthenticatedUser,
  grant: MemberGrantDocument | undefined,
  now = Date.now(),
): MemberDocument {
  const nowIso = new Date(now).toISOString();
  const member = current?.kind === "member"
    ? structuredClone(current)
    : newMember(user, grant?.plan ?? "free", nowIso);

  member.displayName = user.displayName;
  member.provider = user.provider;
  const normalized = normalizeMemberEmail(user.email);
  if (user.email) member.email = user.email;
  if (normalized) member.emailNormalized = normalized;

  if (grant && member.plan !== grant.plan) {
    member.plan = grant.plan;
    member.turnLimit = grant.plan === "unlimited" ? null : configuredFreeTurnLimit();
  } else if (member.plan === "free" && member.turnLimit === null) {
    member.turnLimit = configuredFreeTurnLimit();
  }
  member.turnsUsed = Number.isFinite(member.turnsUsed)
    ? Math.max(0, Math.floor(member.turnsUsed))
    : 0;
  member.reservations = activeReservations(member.reservations, now);
  member.updatedAt = nowIso;
  return member;
}

async function grantForUser(user: AuthenticatedUser): Promise<MemberGrantDocument | undefined> {
  const email = normalizeMemberEmail(user.email);
  if (!email) return undefined;
  const document = await store.get(grantIdForEmail(email));
  return document?.kind === "grant" ? document : undefined;
}

async function changeCurrentMember(
  update: (member: MemberDocument, now: number) => MemberDocument,
): Promise<MemberDocument> {
  const user = currentUser();
  const grant = await grantForUser(user);
  const now = Date.now();
  const document = await store.change(user.userId, (current) => {
    const member = reconcileMember(current, user, grant, now);
    return update(member, now);
  });
  if (document.kind !== "member") throw new Error("Member storage returned an invalid document");
  return document;
}

function isLocalDevelopmentMember(): boolean {
  // This identity is assigned by authenticatedUser() in server-side local mode.
  // Never infer unlimited access from Host, Origin or forwarded request headers.
  const user = currentUser();
  return user.userId === "local-development" && user.provider === "local";
}

export async function getCurrentMembership(): Promise<MembershipView> {
  // Local testing has no account quota. Bypass old exhausted member documents
  // rather than requiring a reset or persisting a grant that could affect hosting.
  if (isLocalDevelopmentMember()) {
    return { plan: "unlimited", turnLimit: null, turnsUsed: 0, turnsRemaining: null };
  }
  const member = await changeCurrentMember((current) => current);
  return membershipView(member);
}

export async function reserveMemberTurn(): Promise<MemberTurnReservationToken> {
  if (isLocalDevelopmentMember()) return { id: "", unlimited: true };
  const reservationId = crypto.randomUUID().replaceAll("-", "");
  let unlimited = false;

  await changeCurrentMember((member, now) => {
    if (member.plan === "unlimited") {
      unlimited = true;
      return member;
    }

    const view = membershipView(member, now);
    if ((view.turnsRemaining ?? 0) <= 0) {
      throw new TurnLimitReachedError(view);
    }

    member.reservations.push({
      id: reservationId,
      expiresAt: new Date(now + reservationLifetimeMs()).toISOString(),
    });
    member.updatedAt = new Date(now).toISOString();
    return member;
  });

  return unlimited
    ? { id: "", unlimited: true }
    : { id: reservationId, unlimited: false };
}

export async function commitMemberTurn(
  reservation: MemberTurnReservationToken,
): Promise<void> {
  if (reservation.unlimited || isLocalDevelopmentMember()) return;
  await changeCurrentMember((member, now) => {
    const index = member.reservations.findIndex((item) => item.id === reservation.id);
    if (index < 0) return member;
    member.reservations.splice(index, 1);
    member.turnsUsed += 1;
    member.updatedAt = new Date(now).toISOString();
    return member;
  });
}

export async function releaseMemberTurn(
  reservation: MemberTurnReservationToken,
): Promise<void> {
  if (reservation.unlimited || isLocalDevelopmentMember()) return;
  await changeCurrentMember((member, now) => {
    member.reservations = member.reservations.filter((item) => item.id !== reservation.id);
    member.updatedAt = new Date(now).toISOString();
    return member;
  });
}

export async function setMemberPlanForEmail(
  rawEmail: string,
  plan: MemberPlan,
): Promise<void> {
  const email = normalizeMemberEmail(rawEmail);
  if (!email) throw new Error("A valid email address is required");
  const id = grantIdForEmail(email);
  const existing = await store.get(id);
  const now = new Date().toISOString();
  const createdAt = existing?.kind === "grant" ? existing.createdAt : now;
  await store.put({
    kind: "grant",
    id,
    userId: id,
    email,
    emailNormalized: email,
    plan,
    createdAt,
    updatedAt: now,
  });
}
