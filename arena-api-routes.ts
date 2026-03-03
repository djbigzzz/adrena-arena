/**
 * Adrena Arena — REST API Routes
 * 
 * Drop these into the AdrenaFoundation/frontend Next.js app under
 * /pages/api/arena/ (or as Express routes in a standalone service).
 * 
 * All endpoints are public (read-only) — no auth needed.
 * Rate limit: 60 req/min per IP via middleware.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { db } from "../../db";
import { MISSION_DEFINITIONS } from "../../../indexer/src/mission-engine";

// ─── GET /api/arena/leaderboard ──────────────────────────────────────────────
// Returns the top-100 traders by total Mutagen for the current season.

export async function leaderboard(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();

  const limit  = Math.min(parseInt(req.query.limit as string) || 100, 100);
  const offset = parseInt(req.query.offset as string) || 0;

  const result = await db.query(
    `SELECT
       rank,
       trader,
       display_name,
       guild_name,
       total_mutagen,
       base_mutagen,
       mission_mutagen,
       volume_usd,
       total_trades,
       missions_completed,
       current_win_streak,
       battle_pass_tier,
       total_xp,
       updated_at
     FROM arena_leaderboard_snapshot
     ORDER BY total_mutagen DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return res.status(200).json({
    leaderboard: result.rows,
    total:       result.rowCount,
    offset,
    updatedAt:   result.rows[0]?.updated_at ?? null,
  });
}

// ─── GET /api/arena/trader/:wallet ───────────────────────────────────────────
// Returns full stats + mission progress for a given trader wallet.

export async function traderStats(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();

  const { wallet } = req.query as { wallet: string };
  if (!wallet || wallet.length < 32) return res.status(400).json({ error: "invalid wallet" });

  // Leaderboard summary
  const lb = await db.query(
    `SELECT * FROM arena_leaderboard_snapshot WHERE trader = $1`,
    [wallet]
  );

  // XP details
  const xp = await db.query(
    `SELECT COALESCE(SUM(xp),0) AS total_xp FROM arena_xp_ledger WHERE trader = $1`,
    [wallet]
  );

  // Mission progress for current cycles
  const missions = await db.query(
    `SELECT
       mp.mission_id,
       mp.mission_type,
       mp.progress,
       mp.target,
       mp.completed,
       mp.completed_at,
       mp.xp_awarded,
       mp.bonus_multiplier,
       mp.cycle_start
     FROM arena_mission_progress mp
     WHERE mp.trader = $1
       AND mp.cycle_start >= CASE mp.mission_type
         WHEN 'daily'  THEN date_trunc('day',  NOW() AT TIME ZONE 'UTC')
         WHEN 'weekly' THEN date_trunc('week', NOW() AT TIME ZONE 'UTC')
         ELSE '2026-02-01'::timestamptz
       END
     ORDER BY mp.mission_type, mp.mission_id`,
    [wallet]
  );

  // Active (unconsumed) bonuses
  const bonuses = await db.query(
    `SELECT mission_id, bonus_multiplier, earned_at
     FROM arena_mission_bonuses
     WHERE trader = $1 AND bonus_used = false
     ORDER BY earned_at`,
    [wallet]
  );

  // Combined bonus multiplier pending on next trade
  const pendingBonus = bonuses.rows.reduce(
    (acc: number, b: any) => acc * parseFloat(b.bonus_multiplier), 1.0
  );

  // 30-day PnL history
  const pnlHistory = await db.query(
    `SELECT
       DATE(closed_at AT TIME ZONE 'UTC') AS day,
       SUM(pnl_usd)::FLOAT               AS daily_pnl,
       COUNT(*)::INT                      AS trade_count,
       SUM(final_mutagen)::FLOAT          AS daily_mutagen
     FROM arena_trade_events
     WHERE trader = $1
       AND closed_at >= NOW() - INTERVAL '30 days'
     GROUP BY day
     ORDER BY day`,
    [wallet]
  );

  // Enrich mission list with definition metadata
  const missionMap = Object.fromEntries(
    MISSION_DEFINITIONS.map(m => [m.id, m])
  );
  const enrichedMissions = missions.rows.map((row: any) => ({
    ...row,
    name:        missionMap[row.mission_id]?.name ?? row.mission_id,
    description: missionMap[row.mission_id]?.description ?? "",
  }));

  return res.status(200).json({
    wallet,
    summary:        lb.rows[0] ?? null,
    totalXp:        parseInt(xp.rows[0].total_xp),
    missions:       enrichedMissions,
    activeBonuses:  bonuses.rows,
    pendingBonus,
    pnlHistory:     pnlHistory.rows,
  });
}

// ─── GET /api/arena/missions ──────────────────────────────────────────────────
// Returns the full mission definitions catalogue for the current season.

export async function missionsDefinitions(_req: NextApiRequest, res: NextApiResponse) {
  // Group by type for convenient frontend rendering
  const daily  = MISSION_DEFINITIONS.filter(m => m.type === "daily");
  const weekly = MISSION_DEFINITIONS.filter(m => m.type === "weekly");
  const elite  = MISSION_DEFINITIONS.filter(m => m.type === "elite");

  return res.status(200).json({
    season:  "S1",
    dailyResetUtc:  "00:00",
    weeklyResetDay: "Monday",
    seasonEnd:      "2026-04-30T23:59:59Z",
    missions: { daily, weekly, elite },
  });
}

// ─── GET /api/arena/stats ────────────────────────────────────────────────────
// Global season stats for the hero banner.

export async function globalStats(_req: NextApiRequest, res: NextApiResponse) {
  const [traders, volume, mutagen, missions] = await Promise.all([
    db.query(`SELECT COUNT(DISTINCT trader) AS c FROM arena_leaderboard_snapshot`),
    db.query(`SELECT COALESCE(SUM(volume_usd),0) AS v FROM arena_leaderboard_snapshot`),
    db.query(`SELECT COALESCE(SUM(total_mutagen),0) AS m FROM arena_leaderboard_snapshot`),
    db.query(`SELECT COUNT(*) AS c FROM arena_mission_progress WHERE completed = true`),
  ]);

  return res.status(200).json({
    season:              "S1",
    totalTraders:        parseInt(traders.rows[0].c),
    totalVolumeUsd:      parseFloat(volume.rows[0].v),
    totalMutagen:        parseFloat(mutagen.rows[0].m),
    totalMissionsCompleted: parseInt(missions.rows[0].c),
    lastUpdated:         new Date().toISOString(),
  });
}
