/**
 * Adrena Arena — Mission Engine
 * 
 * Evaluates mission completion conditions against on-chain position events
 * and manages the mission bonus queue per trader.
 * 
 * Missions are defined in the database (mission_definitions table) so they
 * can be updated by the Adrena team without code changes.
 */

import type { PositionCloseEvent } from "./index";

// ─── TYPES ──────────────────────────────────────────────────────────────────

export type MissionType = "daily" | "weekly" | "elite";
export type MissionConditionType =
  | "first_trade_today"          // Any trade today (min $500)
  | "volume_today"               // Cumulative volume today ≥ target_usd
  | "close_in_profit"            // Close at least one position with pnl > 0
  | "trade_in_window"            // Close a position in UTC hour range [start, end]
  | "hold_duration"              // Close a position open for ≥ target_seconds
  | "trade_count_week"           // Total closed positions this week ≥ target_count
  | "stop_loss_trades"           // Positions with SL attached this week ≥ target_count
  | "short_while_sentiment_long" // Open a short when sentiment > 70% long
  | "cumulative_volume_season"   // Season total volume ≥ target_usd
  | "gauntlet_win_streak";       // Win N consecutive Gauntlet matches

interface MissionDefinition {
  id:           string;
  type:         MissionType;
  name:         string;
  description:  string;
  condition:    MissionConditionType;
  targetValue:  number;     // context-dependent (usd, count, seconds, etc.)
  bonusMultiplier: number;  // e.g. 1.10 = +10% to next closed position mutagen
  xpReward:     number;
  minSizeUsd:   number;     // position must be >= this size to count
}

interface TraderMissionState {
  missionId:    string;
  trader:       string;
  progress:     number;   // 0 → targetValue
  completed:    boolean;
  completedAt:  Date | null;
  bonusUsed:    boolean;  // bonus has been consumed on a trade
}

// ─── MISSION DEFINITIONS ────────────────────────────────────────────────────
// In production: loaded from DB. Hard-coded here for reference.

export const MISSION_DEFINITIONS: MissionDefinition[] = [
  // ── DAILY ─────────────────────────────────────────────────────────────
  {
    id: "daily_first_blood", type: "daily",
    name: "First Blood", description: "Open and close your first position today (min $500)",
    condition: "first_trade_today", targetValue: 1, minSizeUsd: 500,
    bonusMultiplier: 1.05, xpReward: 50,
  },
  {
    id: "daily_volume_runner", type: "daily",
    name: "Volume Runner", description: "Execute $2,500 in notional volume today",
    condition: "volume_today", targetValue: 2500, minSizeUsd: 500,
    bonusMultiplier: 1.10, xpReward: 75,
  },
  {
    id: "daily_profit_lock", type: "daily",
    name: "Profit Lock", description: "Close at least one position in profit today",
    condition: "close_in_profit", targetValue: 1, minSizeUsd: 500,
    bonusMultiplier: 1.15, xpReward: 100,
  },
  {
    id: "daily_night_owl", type: "daily",
    name: "Night Owl", description: "Close a position between 00:00–06:00 UTC (min $1,000)",
    condition: "trade_in_window", targetValue: 6, minSizeUsd: 1000,  // targetValue = end hour UTC
    bonusMultiplier: 1.08, xpReward: 60,
  },
  // ── WEEKLY ────────────────────────────────────────────────────────────
  {
    id: "weekly_diamond_hands", type: "weekly",
    name: "Diamond Hands", description: "Hold a profitable position for 12+ hours",
    condition: "hold_duration", targetValue: 12 * 3600, minSizeUsd: 500,
    bonusMultiplier: 1.25, xpReward: 250,
  },
  {
    id: "weekly_street_fighter", type: "weekly",
    name: "Street Fighter", description: "Complete 15 trades this week",
    condition: "trade_count_week", targetValue: 15, minSizeUsd: 500,
    bonusMultiplier: 1.30, xpReward: 300,
  },
  {
    id: "weekly_risk_manager", type: "weekly",
    name: "Risk Manager", description: "Attach a stop-loss on 5 separate positions this week",
    condition: "stop_loss_trades", targetValue: 5, minSizeUsd: 500,
    bonusMultiplier: 1.20, xpReward: 200,
  },
  {
    id: "weekly_contrarian", type: "weekly",
    name: "Contrarian", description: "Open a short while overall sentiment is >70% long",
    condition: "short_while_sentiment_long", targetValue: 1, minSizeUsd: 1000,
    bonusMultiplier: 1.35, xpReward: 350,
  },
  // ── ELITE (SEASON) ────────────────────────────────────────────────────
  {
    id: "elite_century_club", type: "elite",
    name: "Century Club", description: "Accumulate $100,000 in notional volume this season",
    condition: "cumulative_volume_season", targetValue: 100_000, minSizeUsd: 500,
    bonusMultiplier: 1.50, xpReward: 1500,
  },
  {
    id: "elite_undefeated", type: "elite",
    name: "Undefeated", description: "Win 7 consecutive Gauntlet head-to-head matchups",
    condition: "gauntlet_win_streak", targetValue: 7, minSizeUsd: 0,
    bonusMultiplier: 2.00, xpReward: 2000,
  },
];

// ─── MISSION ENGINE ─────────────────────────────────────────────────────────

export class MissionEngine {
  constructor(private db: any) {}

  /**
   * Consume all active (earned but unused) mission bonuses for a trader.
   * Returns the combined multiplier (product of all individual bonuses).
   * Marks each bonus as consumed so it applies to exactly one trade.
   */
  async consumeActiveBonuses(trader: string): Promise<number> {
    const result = await this.db.query(
      `SELECT bonus_multiplier
       FROM arena_mission_bonuses
       WHERE trader = $1
         AND bonus_used = false
         AND earned_at <= NOW()
       FOR UPDATE`,
      [trader]
    );

    if (result.rows.length === 0) return 1.0;

    // Mark all as consumed
    await this.db.query(
      `UPDATE arena_mission_bonuses
       SET bonus_used = true, used_at = NOW()
       WHERE trader = $1 AND bonus_used = false`,
      [trader]
    );

    // Multiply all bonuses together
    const combined = result.rows.reduce(
      (acc: number, row: any) => acc * parseFloat(row.bonus_multiplier),
      1.0
    );

    return combined;
  }

  /**
   * Evaluate all incomplete missions for a trader against a new close event.
   * Awards XP and queues mission bonuses for completed missions.
   */
  async evaluateMissions(trader: string, event: PositionCloseEvent): Promise<void> {
    for (const mission of MISSION_DEFINITIONS) {
      await this.evaluateSingleMission(trader, mission, event);
    }
  }

  private async evaluateSingleMission(
    trader: string,
    mission: MissionDefinition,
    event: PositionCloseEvent
  ): Promise<void> {
    // Skip if already completed this cycle
    const existing = await this.db.query(
      `SELECT completed, bonus_used FROM arena_mission_progress
       WHERE trader = $1 AND mission_id = $2 AND cycle_start = $3`,
      [trader, mission.id, this.getCycleStart(mission.type)]
    );
    if (existing.rows[0]?.completed) return;

    // Minimum size check
    if (event.sizeUsd < mission.minSizeUsd) return;

    const newProgress = await this.computeProgress(trader, mission, event);
    const completed = newProgress >= mission.targetValue;

    // Upsert progress
    await this.db.query(
      `INSERT INTO arena_mission_progress
         (trader, mission_id, mission_type, progress, target, completed,
          completed_at, cycle_start, xp_awarded, bonus_multiplier)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (trader, mission_id, cycle_start) DO UPDATE SET
         progress     = EXCLUDED.progress,
         completed    = EXCLUDED.completed,
         completed_at = EXCLUDED.completed_at,
         xp_awarded   = EXCLUDED.xp_awarded`,
      [
        trader, mission.id, mission.type,
        newProgress, mission.targetValue,
        completed,
        completed ? new Date() : null,
        this.getCycleStart(mission.type),
        completed ? mission.xpReward : 0,
        mission.bonusMultiplier,
      ]
    );

    if (completed) {
      console.log(`[Arena] ✓ ${trader.slice(0, 8)}… completed mission: ${mission.name} (+${mission.xpReward} XP, ${mission.bonusMultiplier}× next trade)`);

      // Queue the bonus (applies to their NEXT closed position, not this one)
      await this.db.query(
        `INSERT INTO arena_mission_bonuses
           (trader, mission_id, bonus_multiplier, bonus_used, earned_at)
         VALUES ($1,$2,$3,false,NOW())`,
        [trader, mission.id, mission.bonusMultiplier]
      );

      // Award XP toward Battle Pass
      await this.db.query(
        `INSERT INTO arena_xp_ledger (trader, xp, reason, awarded_at)
         VALUES ($1,$2,$3,NOW())`,
        [trader, mission.xpReward, `mission:${mission.id}`]
      );
    }
  }

  // ─── CONDITION EVALUATORS ─────────────────────────────────────────────────

  private async computeProgress(
    trader: string,
    mission: MissionDefinition,
    event: PositionCloseEvent
  ): Promise<number> {
    const cycleStart = this.getCycleStart(mission.type);

    switch (mission.condition) {
      case "first_trade_today":
        // Count closed positions today ≥ minSizeUsd
        return await this.countTradesInCycle(trader, cycleStart);

      case "volume_today":
        // Cumulative volume of closed positions today
        return await this.sumVolumeInCycle(trader, cycleStart) + event.sizeUsd;

      case "close_in_profit":
        // Any trade closed in profit today
        if (event.pnlAfterFees > 0) return 1;
        return await this.countProfitableTradesInCycle(trader, cycleStart);

      case "trade_in_window": {
        // Closed position in UTC hour < targetValue (targetValue = end_hour)
        const closeHour = new Date(event.closeTimestamp * 1000).getUTCHours();
        if (closeHour < mission.targetValue) return 1;
        return 0;
      }

      case "hold_duration":
        // Close a position held for >= targetValue seconds AND in profit
        if (event.durationSeconds >= mission.targetValue && event.pnlAfterFees > 0) return 1;
        return 0;

      case "trade_count_week":
        return await this.countTradesInCycle(trader, cycleStart) + 1;

      case "stop_loss_trades":
        // Requires checking if the position had a StopLossThread PDA at open time.
        // In production: track SL presence in arena_positions table during openPosition parse.
        return await this.countStopLossTradesInCycle(trader, cycleStart);

      case "short_while_sentiment_long":
        // Requires an external sentiment feed. In production: query Adrena's
        // open interest imbalance from the Cortex account at time of position open.
        // OI sentiment = longOI / (longOI + shortOI). If > 0.7 AND this is a short: complete.
        if (event.side === "short") {
          const sentiment = await this.fetchSentimentAtTime(event.openTimestamp);
          if (sentiment > 0.70) return 1;
        }
        return 0;

      case "cumulative_volume_season":
        return await this.sumVolumeInCycle(trader, cycleStart) + event.sizeUsd;

      case "gauntlet_win_streak":
        // Gauntlet is a separate subsystem; progress updated by GauntletEngine
        return await this.getGauntletStreak(trader);

      default:
        return 0;
    }
  }

  // ─── DB HELPERS ──────────────────────────────────────────────────────────

  private getCycleStart(type: MissionType): Date {
    const now = new Date();
    if (type === "daily") {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    }
    if (type === "weekly") {
      const day = now.getUTCDay(); // 0=Sun
      const monday = new Date(now);
      monday.setUTCDate(now.getUTCDate() - ((day + 6) % 7));
      monday.setUTCHours(0, 0, 0, 0);
      return monday;
    }
    // Elite: start of season (hard-coded per season)
    return new Date("2026-02-01T00:00:00Z");
  }

  private async countTradesInCycle(trader: string, since: Date): Promise<number> {
    const r = await this.db.query(
      `SELECT COUNT(*) FROM arena_trade_events
       WHERE trader=$1 AND closed_at >= $2 AND NOT is_liquidation`,
      [trader, since]
    );
    return parseInt(r.rows[0].count);
  }

  private async sumVolumeInCycle(trader: string, since: Date): Promise<number> {
    const r = await this.db.query(
      `SELECT COALESCE(SUM(size_usd),0) FROM arena_trade_events
       WHERE trader=$1 AND closed_at >= $2`,
      [trader, since]
    );
    return parseFloat(r.rows[0].coalesce);
  }

  private async countProfitableTradesInCycle(trader: string, since: Date): Promise<number> {
    const r = await this.db.query(
      `SELECT COUNT(*) FROM arena_trade_events
       WHERE trader=$1 AND closed_at >= $2 AND pnl_usd > 0`,
      [trader, since]
    );
    return parseInt(r.rows[0].count);
  }

  private async countStopLossTradesInCycle(trader: string, since: Date): Promise<number> {
    const r = await this.db.query(
      `SELECT COUNT(*) FROM arena_trade_events
       WHERE trader=$1 AND closed_at >= $2 AND had_stop_loss = true`,
      [trader, since]
    );
    return parseInt(r.rows[0].count);
  }

  private async fetchSentimentAtTime(timestamp: number): Promise<number> {
    // In production: fetch Adrena Cortex account at the given block time via
    // connection.getAccountInfoAndContext with the appropriate commitment.
    // The Cortex account contains global pool OI stats.
    // For now: return a placeholder. Coordinate with Adrena team for exact field name.
    return 0.65; // placeholder
  }

  private async getGauntletStreak(trader: string): Promise<number> {
    const r = await this.db.query(
      `SELECT COALESCE(current_win_streak, 0) FROM arena_gauntlet_stats WHERE trader=$1`,
      [trader]
    );
    return parseInt(r.rows[0]?.coalesce ?? "0");
  }
}
