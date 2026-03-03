-- ============================================================
--  Adrena Arena — PostgreSQL Schema
-- ============================================================

-- All timestamps stored as UTC.
-- Mutagen values stored as NUMERIC(20,6) to match Adrena precision.

-- ─── CORE TRADE EVENTS ────────────────────────────────────────────────────
-- One row per closed/liquidated position on the Adrena program.
-- The indexer inserts here; the mission engine reads from here.

CREATE TABLE IF NOT EXISTS arena_trade_events (
  id               BIGSERIAL PRIMARY KEY,
  trader           VARCHAR(44)    NOT NULL,  -- base58 wallet
  tx_signature     VARCHAR(128)   NOT NULL UNIQUE,
  position_key     VARCHAR(44),              -- Position PDA
  side             VARCHAR(5),               -- 'long' | 'short'
  size_usd         NUMERIC(20,2)  NOT NULL,  -- notional USD
  pnl_usd          NUMERIC(20,6)  NOT NULL,  -- PnL after fees (can be negative)
  duration_seconds INTEGER        NOT NULL,
  had_stop_loss    BOOLEAN        DEFAULT FALSE,
  is_liquidation   BOOLEAN        DEFAULT FALSE,
  -- Mutagen breakdown
  base_mutagen     NUMERIC(20,6)  NOT NULL,
  mission_bonus    NUMERIC(10,6)  DEFAULT 1.0,
  final_mutagen    NUMERIC(20,6)  NOT NULL,
  -- Timing
  closed_at        TIMESTAMPTZ    NOT NULL,
  indexed_at       TIMESTAMPTZ    DEFAULT NOW()
);

CREATE INDEX idx_ate_trader       ON arena_trade_events (trader);
CREATE INDEX idx_ate_closed_at    ON arena_trade_events (closed_at);
CREATE INDEX idx_ate_trader_day   ON arena_trade_events (trader, closed_at);

-- ─── MISSION PROGRESS ─────────────────────────────────────────────────────
-- Tracks each trader's progress on each mission for each cycle.

CREATE TABLE IF NOT EXISTS arena_mission_progress (
  id               BIGSERIAL PRIMARY KEY,
  trader           VARCHAR(44)    NOT NULL,
  mission_id       VARCHAR(64)    NOT NULL,
  mission_type     VARCHAR(10)    NOT NULL,  -- 'daily' | 'weekly' | 'elite'
  progress         NUMERIC(20,4)  NOT NULL DEFAULT 0,
  target           NUMERIC(20,4)  NOT NULL,
  completed        BOOLEAN        DEFAULT FALSE,
  completed_at     TIMESTAMPTZ,
  cycle_start      TIMESTAMPTZ    NOT NULL,  -- UTC start of the daily/weekly/season cycle
  xp_awarded       INTEGER        DEFAULT 0,
  bonus_multiplier NUMERIC(6,4)   NOT NULL,
  UNIQUE (trader, mission_id, cycle_start)
);

CREATE INDEX idx_amp_trader       ON arena_mission_progress (trader);
CREATE INDEX idx_amp_cycle        ON arena_mission_progress (trader, cycle_start);
CREATE INDEX idx_amp_completed    ON arena_mission_progress (trader, completed, cycle_start);

-- ─── MISSION BONUSES (BONUS QUEUE) ────────────────────────────────────────
-- Bonuses queued for the trader's next closed position.
-- Each row is consumed exactly once when the trader closes their next trade.

CREATE TABLE IF NOT EXISTS arena_mission_bonuses (
  id               BIGSERIAL PRIMARY KEY,
  trader           VARCHAR(44)    NOT NULL,
  mission_id       VARCHAR(64)    NOT NULL,
  bonus_multiplier NUMERIC(6,4)   NOT NULL,
  bonus_used       BOOLEAN        DEFAULT FALSE,
  earned_at        TIMESTAMPTZ    DEFAULT NOW(),
  used_at          TIMESTAMPTZ
);

CREATE INDEX idx_amb_trader_unused ON arena_mission_bonuses (trader, bonus_used)
  WHERE bonus_used = false;

-- ─── XP LEDGER ────────────────────────────────────────────────────────────
-- Append-only log of all XP events. Current XP = SUM(xp) per trader.

CREATE TABLE IF NOT EXISTS arena_xp_ledger (
  id        BIGSERIAL PRIMARY KEY,
  trader    VARCHAR(44)    NOT NULL,
  xp        INTEGER        NOT NULL,
  reason    VARCHAR(128)   NOT NULL,  -- e.g. 'mission:daily_first_blood'
  awarded_at TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX idx_axl_trader ON arena_xp_ledger (trader);

-- Materialised view for current XP per trader (refresh every 5 minutes)
CREATE MATERIALIZED VIEW IF NOT EXISTS arena_trader_xp AS
  SELECT
    trader,
    SUM(xp)::INTEGER          AS total_xp,
    -- Tier thresholds from design doc
    CASE
      WHEN SUM(xp) >= 15000 THEN 8
      WHEN SUM(xp) >= 11000 THEN 7
      WHEN SUM(xp) >=  9000 THEN 6
      WHEN SUM(xp) >=  7000 THEN 5
      WHEN SUM(xp) >=  5000 THEN 4
      WHEN SUM(xp) >=  3000 THEN 3
      WHEN SUM(xp) >=  1500 THEN 2
      WHEN SUM(xp) >=   500 THEN 1
      ELSE 0
    END                        AS battle_pass_tier,
    MAX(awarded_at)            AS last_xp_at
  FROM arena_xp_ledger
  GROUP BY trader;

CREATE UNIQUE INDEX ON arena_trader_xp (trader);

-- ─── LEADERBOARD SNAPSHOT ─────────────────────────────────────────────────
-- Aggregated per-trader season stats, refreshed every 5 minutes by a cron job.
-- This is what the /api/arena/leaderboard endpoint serves.

CREATE TABLE IF NOT EXISTS arena_leaderboard_snapshot (
  trader               VARCHAR(44)    PRIMARY KEY,
  display_name         VARCHAR(64),   -- fetched from Adrena UserProfile on-chain account
  guild_name           VARCHAR(64),
  total_mutagen        NUMERIC(20,4)  DEFAULT 0,
  base_mutagen         NUMERIC(20,4)  DEFAULT 0,
  mission_mutagen      NUMERIC(20,4)  DEFAULT 0,  -- extra mutagen from bonuses
  volume_usd           NUMERIC(20,2)  DEFAULT 0,
  total_trades         INTEGER        DEFAULT 0,
  missions_completed   INTEGER        DEFAULT 0,
  current_win_streak   INTEGER        DEFAULT 0,   -- day streak
  battle_pass_tier     INTEGER        DEFAULT 0,
  total_xp             INTEGER        DEFAULT 0,
  rank                 INTEGER,
  updated_at           TIMESTAMPTZ    DEFAULT NOW()
);

-- Refresh function (call via pg_cron or a cron job every 5 min)
CREATE OR REPLACE FUNCTION refresh_arena_leaderboard() RETURNS void AS $$
BEGIN
  -- Refresh the materialised XP view
  REFRESH MATERIALIZED VIEW CONCURRENTLY arena_trader_xp;

  -- Upsert leaderboard
  INSERT INTO arena_leaderboard_snapshot
    (trader, total_mutagen, base_mutagen, mission_mutagen,
     volume_usd, total_trades, missions_completed, battle_pass_tier, total_xp, updated_at)
  SELECT
    t.trader,
    SUM(t.final_mutagen)                              AS total_mutagen,
    SUM(t.base_mutagen)                               AS base_mutagen,
    SUM(t.final_mutagen - t.base_mutagen)             AS mission_mutagen,
    SUM(t.size_usd)                                   AS volume_usd,
    COUNT(*)                                          AS total_trades,
    COALESCE(m.missions_done, 0)                      AS missions_completed,
    COALESCE(x.battle_pass_tier, 0)                   AS battle_pass_tier,
    COALESCE(x.total_xp, 0)                           AS total_xp,
    NOW()
  FROM arena_trade_events t
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS missions_done
    FROM arena_mission_progress
    WHERE trader = t.trader AND completed = true
  ) m ON true
  LEFT JOIN arena_trader_xp x ON x.trader = t.trader
  WHERE t.closed_at >= '2026-02-01T00:00:00Z'  -- Season 1 start
  GROUP BY t.trader, m.missions_done, x.battle_pass_tier, x.total_xp
  ON CONFLICT (trader) DO UPDATE SET
    total_mutagen      = EXCLUDED.total_mutagen,
    base_mutagen       = EXCLUDED.base_mutagen,
    mission_mutagen    = EXCLUDED.mission_mutagen,
    volume_usd         = EXCLUDED.volume_usd,
    total_trades       = EXCLUDED.total_trades,
    missions_completed = EXCLUDED.missions_completed,
    battle_pass_tier   = EXCLUDED.battle_pass_tier,
    total_xp           = EXCLUDED.total_xp,
    updated_at         = NOW();

  -- Update ranks
  WITH ranked AS (
    SELECT trader, ROW_NUMBER() OVER (ORDER BY total_mutagen DESC) AS r
    FROM arena_leaderboard_snapshot
  )
  UPDATE arena_leaderboard_snapshot s
  SET rank = r.r
  FROM ranked r
  WHERE s.trader = r.trader;
END;
$$ LANGUAGE plpgsql;

-- ─── GAUNTLET (HEAD-TO-HEAD) ──────────────────────────────────────────────
-- Optional: tracks 1v1 Gauntlet matchup results for the elite mission.

CREATE TABLE IF NOT EXISTS arena_gauntlet_matches (
  id           BIGSERIAL PRIMARY KEY,
  season       VARCHAR(16)  DEFAULT 'S1',
  trader_a     VARCHAR(44)  NOT NULL,
  trader_b     VARCHAR(44)  NOT NULL,
  winner       VARCHAR(44),            -- NULL = in progress
  start_at     TIMESTAMPTZ  DEFAULT NOW(),
  end_at       TIMESTAMPTZ,
  -- Scoring window: both traders' trades during [start_at, end_at] count
  trader_a_mutagen NUMERIC(20,4) DEFAULT 0,
  trader_b_mutagen NUMERIC(20,4) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS arena_gauntlet_stats (
  trader             VARCHAR(44)  PRIMARY KEY,
  total_matches      INTEGER      DEFAULT 0,
  total_wins         INTEGER      DEFAULT 0,
  current_win_streak INTEGER      DEFAULT 0,
  best_win_streak    INTEGER      DEFAULT 0,
  rating             NUMERIC(8,2) DEFAULT 1500  -- Glicko-2 initial rating
);

-- ─── ABUSE DETECTION ──────────────────────────────────────────────────────
-- Log suspicious patterns for manual review.

CREATE TABLE IF NOT EXISTS arena_abuse_flags (
  id           BIGSERIAL    PRIMARY KEY,
  trader       VARCHAR(44)  NOT NULL,
  flag_type    VARCHAR(64)  NOT NULL,  -- 'wash_trade', 'sybil_suspect', etc.
  description  TEXT,
  tx_signature VARCHAR(128),
  flagged_at   TIMESTAMPTZ  DEFAULT NOW(),
  reviewed     BOOLEAN      DEFAULT FALSE,
  action_taken VARCHAR(64)             -- 'warned', 'disqualified', 'cleared'
);
