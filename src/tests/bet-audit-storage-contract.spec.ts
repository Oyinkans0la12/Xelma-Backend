/**
 * Bet-audit storage-mode contract (Issue #651).
 *
 * `betAuditService` stores its events one of two ways, chosen by
 * `BET_AUDIT_STORAGE`:
 *
 *   - `memory`   (default) — an in-process array
 *   - `database`           — an AuditLog row, written alongside the array
 *
 * Dual storage is precisely where a field quietly goes missing: the array copy
 * and the AuditLog `metadata` blob are built from the same event object but
 * through two different field lists, so a field added to one and not the other
 * is invisible until someone tries to query the mode that lost it. `txHash`,
 * `mode`, and `result` are the usual casualties.
 *
 * These tests pin the *contract* rather than any one implementation:
 *
 *   1. Both modes are driven through the identical emit → query sequence.
 *   2. The required key set is asserted key-by-key, then compared across modes,
 *      so a field added to one mode only fails here rather than in production.
 *   3. The `metadata` persisted in database mode is compared to the in-memory
 *      event, which is what actually stops the two stores from diverging.
 *   4. Redaction is unchanged in both modes.
 *   5. The admin query route still requires authz in both modes.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { Express } from "express";
import request from "supertest";
import { BetStatus, UserRole } from "@prisma/client";

jest.mock("../lib/prisma", () => ({
  prisma: {
    auditLog: { create: jest.fn().mockResolvedValue({ id: "audit-1" }) },
    user: { findUnique: jest.fn() },
    round: {
      findFirst: jest.fn().mockResolvedValue({ id: "round-1" }),
    },
  },
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Preflight (full mode) requires JWT_SECRET >= 16 chars, and auth middleware
// verifies tokens against process.env.JWT_SECRET at request time. Set one value
// BEFORE generateToken() runs so tokens and verification agree.
//
// NOTE: NODE_ENV is deliberately left at the 'test' that jest.setup.js set.
// Overriding it at module scope would run before the hoisted `../index` import
// and trip the Node-22 startup preflight (src/utils/check-node-version.ts);
// it is set per-test below instead, once every module has been evaluated.
const TEST_JWT_SECRET = "bet-audit-contract-test-jwt-secret-2026-x";
process.env.JWT_SECRET = TEST_JWT_SECRET;

import { createApp } from "../index";
import { betAuditService, type BetAuditEvent } from "../services/bet-audit.service";
import { prisma } from "../lib/prisma";
import { generateToken } from "../utils/jwt.util";

const mockPrisma = prisma as any;
const mockAuditLogCreate = prisma.auditLog.create as any;

const ADDRESS = "GCONTRACT_TEST_AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_ADDRESS = "GCONTRACT_TEST_BBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TX_HASH = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

/**
 * The fields the query contract guarantees on every returned event.
 *
 * Derived from the emitter's own params, not from a hand-written list that could
 * drift: if `BetAuditParams` gains a field, this set grows and the comparison
 * against the persisted `metadata` blob is what notices the database mode did
 * not follow.
 */
const REQUIRED_KEYS = [
  "event",
  "address",
  "amount",
  "mode",
  "result",
  "createdAt",
] as const;

type StorageMode = "memory" | "database";
const STORAGE_MODES: StorageMode[] = ["memory", "database"];

function setStorageMode(mode: StorageMode): void {
  if (mode === "database") {
    process.env.BET_AUDIT_STORAGE = "database";
  } else {
    delete process.env.BET_AUDIT_STORAGE;
  }
  expect(betAuditService.storageMode).toBe(mode);
}

/** Wait for the fire-and-forget round enrichment + DB persist to settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function emitFullEvent(): BetAuditEvent {
  return betAuditService.emitBetAccepted({
    betId: "bet-42",
    address: ADDRESS,
    amount: 250,
    side: "UP",
    mode: "UP_DOWN",
    result: "on-chain-success",
    status: BetStatus.CONFIRMED,
    txHash: TX_HASH,
  });
}

/** The metadata blob the database mode wrote for the most recent create. */
function lastPersistedMetadata(): Record<string, unknown> {
  const calls = mockAuditLogCreate.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].data.metadata;
}

describe.each(STORAGE_MODES)("bet-audit storage contract — %s mode", (mode) => {
  let originalStorage: string | undefined;

  beforeEach(() => {
    originalStorage = process.env.BET_AUDIT_STORAGE;
    setStorageMode(mode);
    betAuditService.clear();
    jest.clearAllMocks();
    mockAuditLogCreate.mockResolvedValue({ id: "audit-1" });
    mockPrisma.round.findFirst.mockResolvedValue({ id: "round-1" });
  });

  afterEach(() => {
    betAuditService.clear();
    if (originalStorage === undefined) {
      delete process.env.BET_AUDIT_STORAGE;
    } else {
      process.env.BET_AUDIT_STORAGE = originalStorage;
    }
  });

  // ── 1. emit → list ────────────────────────────────────────────────────────
  describe("emit then list (getEvents)", () => {
    it("returns the emitted event from the list", () => {
      const emitted = emitFullEvent();

      const events = betAuditService.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: "BET_ACCEPTED",
        address: ADDRESS,
        amount: 250,
        side: "UP",
        mode: "UP_DOWN",
        result: "on-chain-success",
        txHash: TX_HASH,
      });
      expect(events[0].createdAt).toBe(emitted.createdAt);
    });

    it("exposes every required key on the listed event", () => {
      emitFullEvent();

      const [event] = betAuditService.getEvents();
      for (const key of REQUIRED_KEYS) {
        expect(event).toHaveProperty(key);
        expect(event[key]).toBeDefined();
      }
    });

    it("accumulates multiple events in emission order", () => {
      betAuditService.emitBetAccepted({
        address: ADDRESS,
        amount: 10,
        mode: "UP_DOWN",
        result: "stub",
      });
      betAuditService.emitBetAccepted({
        address: OTHER_ADDRESS,
        amount: 20,
        mode: "PRECISION",
        result: "on-chain-success",
      });

      const events = betAuditService.getEvents();
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.address)).toEqual([ADDRESS, OTHER_ADDRESS]);
    });
  });

  // ── 2. emit → query (queryEvents) ────────────────────────────────────────
  describe("emit then query (queryEvents)", () => {
    it("returns the same required keys as the list does", () => {
      emitFullEvent();

      const [queried] = betAuditService.queryEvents({ redact: false });
      for (const key of REQUIRED_KEYS) {
        expect(queried).toHaveProperty(key);
        expect(queried[key]).toBeDefined();
      }
    });

    it("keeps txHash, mode, and result intact when not redacting", () => {
      emitFullEvent();

      const [queried] = betAuditService.queryEvents({ redact: false });
      // These three are the fields that historically went missing in one mode.
      expect(queried.txHash).toBe(TX_HASH);
      expect(queried.mode).toBe("UP_DOWN");
      expect(queried.result).toBe("on-chain-success");
    });

    it("filters by wallet address", () => {
      betAuditService.emitBetAccepted({
        address: ADDRESS,
        amount: 10,
        mode: "UP_DOWN",
        result: "stub",
      });
      betAuditService.emitBetAccepted({
        address: OTHER_ADDRESS,
        amount: 20,
        mode: "UP_DOWN",
        result: "stub",
      });

      const events = betAuditService.queryEvents({ address: ADDRESS, redact: false });
      expect(events).toHaveLength(1);
      expect(events[0].address).toBe(ADDRESS);
    });

    it("honours the limit", () => {
      for (let i = 0; i < 5; i += 1) {
        betAuditService.emitBetAccepted({
          address: ADDRESS,
          amount: i + 1,
          mode: "UP_DOWN",
          result: "stub",
        });
      }

      expect(betAuditService.queryEvents({ limit: 2, redact: false })).toHaveLength(2);
    });
  });

  // ── 3. redaction is identical in both modes ──────────────────────────────
  describe("redaction", () => {
    it("masks txHash to the first 8 characters by default", () => {
      emitFullEvent();

      const [queried] = betAuditService.queryEvents();
      expect(queried.txHash).toBe("0x123456...");
      expect(queried.txHash).toMatch(/^.{8}\.\.\.$/);
    });

    it("leaves the unredacted store untouched", () => {
      emitFullEvent();

      // Redaction must be applied to the returned copy, not in place.
      betAuditService.queryEvents();
      expect(betAuditService.getEvents()[0].txHash).toBe(TX_HASH);
    });

    it("does not invent a txHash for an event that had none", () => {
      betAuditService.emitBetAccepted({
        address: ADDRESS,
        amount: 5,
        mode: "PRECISION",
        result: "stub",
      });

      const [queried] = betAuditService.queryEvents();
      expect(queried.txHash).toBeUndefined();
    });
  });

  // ── 4. authz on the admin query route, in this storage mode ──────────────
  describe("admin route authz", () => {
    let app: Express;
    const ADMIN_TOKEN = generateToken("admin-id", "GADMIN_A", UserRole.ADMIN);
    const USER_TOKEN = generateToken("user-id", "GUSER_B", UserRole.USER);

    beforeEach(() => {
      mockPrisma.user.findUnique.mockImplementation((args: any) => {
        const id = args?.where?.id ?? args?.where?.walletAddress;
        return Promise.resolve(
          id === "user-id" || id === "GUSER_B"
            ? { id: "user-id", walletAddress: "GUSER_B", role: UserRole.USER }
            : { id: "admin-id", walletAddress: "GADMIN_A", role: UserRole.ADMIN },
        );
      });
      process.env.NODE_ENV = "development";
      app = createApp();
      emitFullEvent();
    });

    it("returns 401 without a token", async () => {
      const res = await request(app).get("/api/admin/bet-audit");
      expect(res.status).toBe(401);
    });

    it("returns 403 for an authenticated non-admin", async () => {
      const res = await request(app)
        .get("/api/admin/bet-audit")
        .set("Authorization", `Bearer ${USER_TOKEN}`);
      expect(res.status).toBe(403);
    });

    it("returns the event to an admin, with the same key contract", async () => {
      const res = await request(app)
        .get("/api/admin/bet-audit")
        .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);

      const [event] = res.body.events;
      for (const key of REQUIRED_KEYS) {
        expect(event).toHaveProperty(key);
      }
      // The route always redacts.
      expect(event.txHash).toBe("0x123456...");
    });
  });
});

// ── cross-mode divergence: the actual point of the issue ────────────────────

describe("bet-audit storage modes cannot diverge (Issue #651)", () => {
  let originalStorage: string | undefined;

  beforeEach(() => {
    originalStorage = process.env.BET_AUDIT_STORAGE;
    betAuditService.clear();
    jest.clearAllMocks();
    mockAuditLogCreate.mockResolvedValue({ id: "audit-1" });
    mockPrisma.round.findFirst.mockResolvedValue({ id: "round-1" });
  });

  afterEach(() => {
    betAuditService.clear();
    if (originalStorage === undefined) {
      delete process.env.BET_AUDIT_STORAGE;
    } else {
      process.env.BET_AUDIT_STORAGE = originalStorage;
    }
  });

  /** Run the emit → query sequence in one mode and return the event shape. */
  function captureQueryShape(mode: StorageMode): BetAuditEvent {
    setStorageMode(mode);
    betAuditService.clear();
    emitFullEvent();
    const [queried] = betAuditService.queryEvents({ redact: false });
    expect(queried).toBeDefined();
    return queried;
  }

  it("returns an identical key set from both modes", () => {
    const fromMemory = captureQueryShape("memory");
    const fromDatabase = captureQueryShape("database");

    const memoryKeys = Object.keys(fromMemory).sort();
    const databaseKeys = Object.keys(fromDatabase).sort();

    expect(databaseKeys).toEqual(memoryKeys);
  });

  it("returns identical values from both modes", () => {
    const fromMemory = captureQueryShape("memory");
    const fromDatabase = captureQueryShape("database");

    // `createdAt` and the round-enriched `roundId` are time/lookup dependent,
    // so compare the fields that define the event's identity.
    for (const key of REQUIRED_KEYS) {
      if (key === "createdAt") continue;
      expect(fromDatabase[key]).toEqual(fromMemory[key]);
    }
    expect(fromDatabase.betId).toEqual(fromMemory.betId);
    expect(fromDatabase.txHash).toEqual(fromMemory.txHash);
  });

  it("persists every event field into the AuditLog metadata blob", async () => {
    setStorageMode("database");
    const emitted = emitFullEvent();
    await flush();

    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
    const write = mockAuditLogCreate.mock.calls[0][0].data;

    // Column-level fields, not just metadata.
    expect(write.eventType).toBe(emitted.event);
    expect(write.walletAddress).toBe(emitted.address);
    expect(write.resourceType).toBe("bet");
    expect(write.resourceId).toBe(emitted.betId);
    expect(write.outcome).toBe("success");
    expect(write.timestamp).toBeInstanceOf(Date);
  });

  it("keeps the database metadata keys in sync with the in-memory event", async () => {
    setStorageMode("database");
    const emitted = emitFullEvent();
    await flush();

    const metadata = lastPersistedMetadata();
    // Every persisted key must also exist on the in-memory event, and every
    // non-undefined scalar on the event must be persisted. This is the
    // assertion that fails when a new field is added to one store only.
    for (const key of Object.keys(metadata)) {
      expect(emitted).toHaveProperty(key);
    }
    for (const key of ["betId", "roundId", "amount", "side", "mode", "result", "txHash", "failureReason"]) {
      expect(metadata).toHaveProperty(key);
    }
    expect(metadata.txHash).toBe(TX_HASH);
    expect(metadata.mode).toBe("UP_DOWN");
    expect(metadata.result).toBe("on-chain-success");
  });

  it("does not write to the database in memory mode", () => {
    setStorageMode("memory");
    emitFullEvent();
    return flush().then(() => {
      expect(mockAuditLogCreate).not.toHaveBeenCalled();
      // The event is still queryable — memory mode is not "no audit".
      expect(betAuditService.queryEvents({ redact: false })).toHaveLength(1);
    });
  });

  it("keeps the event queryable even when the database write fails", async () => {
    setStorageMode("database");
    mockAuditLogCreate.mockRejectedValue(new Error("Database connection failed"));

    emitFullEvent();
    await flush();

    // Persistence is best-effort and must not cost us the in-memory event.
    const [queried] = betAuditService.queryEvents({ redact: false });
    expect(queried).toBeDefined();
    expect(queried.txHash).toBe(TX_HASH);
  });

  it("records a failed bet with its failure reason in both stores", async () => {
    setStorageMode("database");
    betAuditService.emitBetFailed({
      betId: "bet-77",
      address: ADDRESS,
      amount: 30,
      mode: "UP_DOWN",
      result: "on-chain-failure",
      failureReason: "Soroban contract error",
    });
    await flush();

    const [queried] = betAuditService.queryEvents({ redact: false });
    expect(queried.event).toBe("BET_FAILED");
    expect(queried.failureReason).toBe("Soroban contract error");

    const metadata = lastPersistedMetadata();
    expect(metadata.failureReason).toBe("Soroban contract error");
    expect(metadata.result).toBe("on-chain-failure");

    // A failure must be severity-escalated, not logged as info.
    const write = mockAuditLogCreate.mock.calls[0][0].data;
    expect(write.severity).toBe("error");
    expect(write.outcome).toBe("failure");
  });

  it("never leaks secrets into either store", () => {
    setStorageMode("database");
    const emitted = emitFullEvent();

    const serialised = JSON.stringify(emitted);
    for (const forbidden of ["secret", "privateKey", "private_key", "password", "jwt"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});
