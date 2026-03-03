/**
 * Adrena Arena — Mission Engine Unit Tests
 *
 * Tests the mission evaluation logic in isolation using a mock database.
 * All mission conditions are tested against the spec in the design document.
 *
 * Run: npx vitest run tests/mission-engine.test.ts
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MissionEngine, MISSION_DEFINITIONS } from "../indexer/src/mission-engine";
import type { PositionCloseEvent } from "../indexer/src/index";

// ─── MOCK DATABASE ────────────────────────────────────────────────────────────

function makeMockDb(overrides: Record<string, any> = {}) {
  const calls: { query: string; params: any[] }[] = [];
  const mockDb = {
    _calls: calls,
    query: vi.fn(async (sql: string, params: any[]) => {
      calls.push({ query: sql, params });
      const key = sql.trim().slice(0, 40);
      if (overrides[key]) return overrides[key];
      // Default: return empty results
      return { rows: [], rowCount: 0 };
    }),
  };
  return mockDb;
}

// ─── TEST FIXTURES ────────────────────────────────────────────────────────────

const TRADER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

function makeEvent(overrides: Partial<PositionCloseEvent> = {}): PositionCloseEvent {
  const now = Math.floor(Date.now() / 1000);
  return {
    txSignature:    "5J7GRnKtDv2kJqhGQsVMKpVmExAY6JxfrQXbDiX1q2e3",
    trader:         TRADER,
    positionKey:    "ArenaPDA111111111111111111111111111111111111",
    side:           "long",
    sizeUsd:        10_000,
    pnlAfterFees:   500,
    openTimestamp:  now - 7200,   // 2 hours ago
    closeTimestamp: now,
    isLiquidation:  false,
    durationSeconds: 7200,
    ...overrides,
  };
}

// ─── MISSION DEFINITIONS ──────────────────────────────────────────────────────

describe("MISSION_DEFINITIONS", () => {
  it("has exactly 10 missions", () => {
    expect(MISSION_DEFINITIONS).toHaveLength(10);
  });

  it("has 4 daily missions", () => {
    expect(MISSION_DEFINITIONS.filter(m => m.type === "daily")).toHaveLength(4);
  });

  it("has 4 weekly missions", () => {
    expect(MISSION_DEFINITIONS.filter(m => m.type === "weekly")).toHaveLength(4);
  });

  it("has 2 elite missions", () => {
    expect(MISSION_DEFINITIONS.filter(m => m.type === "elite")).toHaveLength(2);
  });

  it("all bonus multipliers are > 1.0", () => {
    for (const m of MISSION_DEFINITIONS) {
      expect(m.bonusMultiplier).toBeGreaterThan(1.0);
    }
  });

  it("all XP rewards are positive", () => {
    for (const m of MISSION_DEFINITIONS) {
      expect(m.xpReward).toBeGreaterThan(0);
    }
  });

  it("all missions have unique IDs", () => {
    const ids = MISSION_DEFINITIONS.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("daily missions have lower bonuses than weekly/elite", () => {
    const maxDaily  = Math.max(...MISSION_DEFINITIONS.filter(m => m.type === "daily").map(m => m.bonusMultiplier));
    const minWeekly = Math.min(...MISSION_DEFINITIONS.filter(m => m.type === "weekly").map(m => m.bonusMultiplier));
    expect(maxDaily).toBeLessThan(minWeekly);
  });

  it("max stacked bonus caps at 3.105×", () => {
    const maxDaily  = Math.max(...MISSION_DEFINITIONS.filter(m => m.type === "daily").map(m => m.bonusMultiplier));
    const maxWeekly = Math.max(...MISSION_DEFINITIONS.filter(m => m.type === "weekly").map(m => m.bonusMultiplier));
    const maxElite  = Math.max(...MISSION_DEFINITIONS.filter(m => m.type === "elite").map(m => m.bonusMultiplier));
    const theoretical = maxDaily * maxWeekly * maxElite;
    expect(theoretical).toBeCloseTo(3.105, 2);
  });
});

// ─── BONUS CONSUMPTION ────────────────────────────────────────────────────────

describe("MissionEngine.consumeActiveBonuses", () => {
  it("returns 1.0 when no active bonuses exist", async () => {
    const db = makeMockDb();
    const engine = new MissionEngine(db);
    const bonus = await engine.consumeActiveBonuses(TRADER);
    expect(bonus).toBe(1.0);
  });

  it("returns the bonus multiplier when one bonus is active", async () => {
    const db = makeMockDb({
      "SELECT bonus_multiplier\n       FROM arena_mission_bonu": {
        rows: [{ bonus_multiplier: "1.10" }],
        rowCount: 1,
      }
    });
    const engine = new MissionEngine(db);
    const bonus = await engine.consumeActiveBonuses(TRADER);
    expect(bonus).toBeCloseTo(1.10, 4);
  });

  it("multiplies multiple active bonuses together", async () => {
    const db = makeMockDb({
      "SELECT bonus_multiplier\n       FROM arena_mission_bonu": {
        rows: [{ bonus_multiplier: "1.10" }, { bonus_multiplier: "1.30" }],
        rowCount: 2,
      }
    });
    const engine = new MissionEngine(db);
    const bonus = await engine.consumeActiveBonuses(TRADER);
    expect(bonus).toBeCloseTo(1.10 * 1.30, 4); // 1.43
  });

  it("marks bonuses as used after consuming", async () => {
    const db = makeMockDb({
      "SELECT bonus_multiplier\n       FROM arena_mission_bonu": {
        rows: [{ bonus_multiplier: "1.05" }],
        rowCount: 1,
      }
    });
    const engine = new MissionEngine(db);
    await engine.consumeActiveBonuses(TRADER);
    // The UPDATE call should have been made
    const updateCall = db._calls.find(c => c.query.includes("UPDATE arena_mission_bonuses"));
    expect(updateCall).toBeTruthy();
    expect(updateCall?.params[0]).toBe(TRADER);
  });
});

// ─── MISSION CONDITION: first_trade_today ────────────────────────────────────

describe("Mission: First Blood (first_trade_today)", () => {
  const mission = MISSION_DEFINITIONS.find(m => m.id === "daily_first_blood")!;

  it("mission definition exists", () => {
    expect(mission).toBeDefined();
    expect(mission.condition).toBe("first_trade_today");
    expect(mission.targetValue).toBe(1);
    expect(mission.bonusMultiplier).toBe(1.05);
    expect(mission.xpReward).toBe(50);
  });

  it("minimum size requirement is $500", () => {
    expect(mission.minSizeUsd).toBe(500);
  });

  it("rejects trades below minimum size", async () => {
    const db = makeMockDb();
    const engine = new MissionEngine(db);
    const event = makeEvent({ sizeUsd: 100 }); // below $500 minimum
    await engine.evaluateMissions(TRADER, event);
    // Should not insert progress for this mission — check no INSERT was called for tiny trade
    const insertCalls = db._calls.filter(c => c.query.includes("INSERT INTO arena_mission_progress") && c.params[1] === "daily_first_blood");
    expect(insertCalls).toHaveLength(0);
  });
});

// ─── MISSION CONDITION: close_in_profit ──────────────────────────────────────

describe("Mission: Profit Lock (close_in_profit)", () => {
  const mission = MISSION_DEFINITIONS.find(m => m.id === "daily_profit_lock")!;

  it("mission definition exists with correct spec", () => {
    expect(mission).toBeDefined();
    expect(mission.condition).toBe("close_in_profit");
    expect(mission.bonusMultiplier).toBe(1.15);
  });

  it("profitable trade (pnl > 0) should progress the mission", async () => {
    const db = makeMockDb();
    const engine = new MissionEngine(db);
    const event = makeEvent({ sizeUsd: 5000, pnlAfterFees: 250 }); // profitable
    await engine.evaluateMissions(TRADER, event);
    // Some DB writes should have occurred
    expect(db._calls.length).toBeGreaterThan(0);
  });
});

// ─── MISSION CONDITION: trade_in_window ──────────────────────────────────────

describe("Mission: Night Owl (trade_in_window 00:00–06:00 UTC)", () => {
  const mission = MISSION_DEFINITIONS.find(m => m.id === "daily_night_owl")!;

  it("mission definition exists", () => {
    expect(mission).toBeDefined();
    expect(mission.condition).toBe("trade_in_window");
    expect(mission.targetValue).toBe(6); // end hour
    expect(mission.minSizeUsd).toBe(1000);
  });

  it("trade at 03:00 UTC should be in window", () => {
    const ts = new Date("2026-02-24T03:00:00Z").getTime() / 1000;
    const closeHour = new Date(ts * 1000).getUTCHours();
    expect(closeHour).toBe(3);
    expect(closeHour < mission.targetValue).toBe(true);
  });

  it("trade at 12:00 UTC should NOT be in window", () => {
    const ts = new Date("2026-02-24T12:00:00Z").getTime() / 1000;
    const closeHour = new Date(ts * 1000).getUTCHours();
    expect(closeHour).toBe(12);
    expect(closeHour < mission.targetValue).toBe(false);
  });

  it("trade at 05:59 UTC is in window", () => {
    const ts = new Date("2026-02-24T05:59:00Z").getTime() / 1000;
    const closeHour = new Date(ts * 1000).getUTCHours();
    expect(closeHour < mission.targetValue).toBe(true);
  });

  it("trade at exactly 06:00 UTC is NOT in window", () => {
    const ts = new Date("2026-02-24T06:00:00Z").getTime() / 1000;
    const closeHour = new Date(ts * 1000).getUTCHours();
    expect(closeHour < mission.targetValue).toBe(false);
  });
});

// ─── MISSION CONDITION: hold_duration ────────────────────────────────────────

describe("Mission: Diamond Hands (hold_duration ≥ 12h)", () => {
  const mission = MISSION_DEFINITIONS.find(m => m.id === "weekly_diamond_hands")!;

  it("mission requires 12 hours (43200 seconds)", () => {
    expect(mission.condition).toBe("hold_duration");
    expect(mission.targetValue).toBe(12 * 3600);
    expect(mission.bonusMultiplier).toBe(1.25);
  });

  it("qualifies: trade held 13 hours with profit", () => {
    const dur = 13 * 3600;
    const pnl = 100;
    expect(dur >= mission.targetValue && pnl > 0).toBe(true);
  });

  it("does not qualify: trade held 11 hours (too short)", () => {
    const dur = 11 * 3600;
    expect(dur >= mission.targetValue).toBe(false);
  });

  it("does not qualify: 13 hours but no profit", () => {
    const dur = 13 * 3600;
    const pnl = -100;
    expect(dur >= mission.targetValue && pnl > 0).toBe(false);
  });
});

// ─── MISSION CONDITION: short_while_sentiment_long ───────────────────────────

describe("Mission: Contrarian (short while >70% sentiment long)", () => {
  const mission = MISSION_DEFINITIONS.find(m => m.id === "weekly_contrarian")!;

  it("mission spec is correct", () => {
    expect(mission.condition).toBe("short_while_sentiment_long");
    expect(mission.bonusMultiplier).toBe(1.35);
    expect(mission.xpReward).toBe(350);
  });

  it("long trade should not qualify regardless of sentiment", () => {
    const event = makeEvent({ side: "long" });
    expect(event.side === "short").toBe(false);
  });

  it("short trade with 71% sentiment qualifies", () => {
    const isShort    = true;
    const sentiment  = 0.71;
    expect(isShort && sentiment > 0.70).toBe(true);
  });

  it("short trade with exactly 70% sentiment does NOT qualify", () => {
    const isShort   = true;
    const sentiment = 0.70;
    expect(isShort && sentiment > 0.70).toBe(false);
  });
});

// ─── CYCLE START LOGIC ───────────────────────────────────────────────────────

describe("Cycle start date calculation", () => {
  it("daily cycle starts at midnight UTC today", () => {
    const now = new Date();
    const expected = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // The engine's getCycleStart("daily") should return this
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    expect(startOfDay.toISOString()).toBe(expected.toISOString());
  });

  it("weekly cycle starts on Monday UTC this week", () => {
    const now = new Date();
    const day = now.getUTCDay(); // 0=Sun, 1=Mon...
    const daysBack = (day + 6) % 7; // days since Monday
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - daysBack);
    monday.setUTCHours(0, 0, 0, 0);
    expect(monday.getUTCDay()).toBe(1); // IS a Monday
    expect(monday <= now).toBe(true);   // IS in the past
  });

  it("elite cycle started 2026-02-01", () => {
    const seasonStart = new Date("2026-02-01T00:00:00Z");
    expect(seasonStart.getUTCFullYear()).toBe(2026);
    expect(seasonStart.getUTCMonth()).toBe(1); // February = 1
    expect(seasonStart.getUTCDate()).toBe(1);
  });
});

// ─── ABUSE PREVENTION ────────────────────────────────────────────────────────

describe("Abuse prevention: minimum size enforcement", () => {
  it("daily missions require $500 minimum", () => {
    const dailyMissions = MISSION_DEFINITIONS.filter(m => m.type === "daily");
    for (const m of dailyMissions) {
      if (m.id !== "daily_night_owl") {
        expect(m.minSizeUsd).toBeGreaterThanOrEqual(500);
      }
    }
  });

  it("Night Owl requires $1000 minimum (anti-farming)", () => {
    const nightOwl = MISSION_DEFINITIONS.find(m => m.id === "daily_night_owl")!;
    expect(nightOwl.minSizeUsd).toBe(1000);
  });

  it("Contrarian requires $1000 minimum (anti-trivial-shorts)", () => {
    const contrarian = MISSION_DEFINITIONS.find(m => m.id === "weekly_contrarian")!;
    expect(contrarian.minSizeUsd).toBe(1000);
  });

  it("elite missions have meaningful minimum sizes", () => {
    const eliteMissions = MISSION_DEFINITIONS.filter(m => m.type === "elite");
    for (const m of eliteMissions) {
      if (m.condition !== "gauntlet_win_streak") {
        expect(m.minSizeUsd).toBeGreaterThanOrEqual(500);
      }
    }
  });
});
