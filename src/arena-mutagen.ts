/**
 * Adrena Arena — Mutagen Formula
 *
 * Exact implementation using the official Size Multiplier table
 * provided by br0wnD3v via:
 *   GET https://adrena-competition-service.onrender.com/<API_KEY>/size-multiplier
 *
 * PnL field names confirmed from position-schema endpoint:
 *   - profit_usd  (u64, USD × 10^6) — realized profit, 0 if losing
 *   - loss_usd    (u64, USD × 10^6) — realized loss,   0 if winning
 *   - Net PnL = profit_usd - loss_usd
 *   - Values are AFTER borrow fees and funding, BEFORE exit fees
 */

// ─── EXACT SIZE MULTIPLIER TABLE ─────────────────────────────────────────────
// Source: adrena-competition-service.onrender.com/<API_KEY>/size-multiplier
// Interpolation is LINEAR within each tier.
// Below $10 or above $4.5M → multiplier = 0

const SIZE_TIERS = [
  { minSize:         10, maxSize:      1_000, multiplierMin: 0.00025, multiplierMax:  0.05 },
  { minSize:      1_000, maxSize:      5_000, multiplierMin:    0.05, multiplierMax:  1.00 },
  { minSize:      5_000, maxSize:     50_000, multiplierMin:    1.00, multiplierMax:  5.00 },
  { minSize:     50_000, maxSize:    100_000, multiplierMin:    5.00, multiplierMax:  9.00 },
  { minSize:    100_000, maxSize:    250_000, multiplierMin:    9.00, multiplierMax: 17.50 },
  { minSize:    250_000, maxSize:    500_000, multiplierMin:   17.50, multiplierMax: 25.00 },
  { minSize:    500_000, maxSize:  1_000_000, multiplierMin:   25.00, multiplierMax: 30.00 },
  { minSize:  1_000_000, maxSize:  4_500_000, multiplierMin:   30.00, multiplierMax: 45.00 },
];

export function sizeMultiplier(sizeUsd: number): number {
  if (sizeUsd < 10 || sizeUsd > 4_500_000) return 0;
  const tier = SIZE_TIERS.find(t => sizeUsd >= t.minSize && sizeUsd <= t.maxSize);
  if (!tier) return 0;
  return tier.multiplierMin +
    ((sizeUsd - tier.minSize) * (tier.multiplierMax - tier.multiplierMin)) /
    (tier.maxSize - tier.minSize);
}

// ─── TRADE PERFORMANCE MUTAGEN ───────────────────────────────────────────────

const VOLUME_MINIMUMS = [
  { minVolume: 1_000_000, minMutagen: 0.15 },
  { minVolume:   100_000, minMutagen: 0.10 },
];

export function tradePerformanceMutagen(sizeUsd: number, netPnlUsd: number): number {
  if (sizeUsd <= 0) return 0;
  const pnlPct  = (netPnlUsd / sizeUsd) * 100;
  const clamped = Math.max(0.1, Math.min(7.5, pnlPct));
  const fromPerf = ((clamped - 0.1) / (7.5 - 0.1)) * 0.3;
  const minimum  = VOLUME_MINIMUMS.find(v => sizeUsd >= v.minVolume)?.minMutagen ?? 0;
  return Math.max(fromPerf, minimum);
}

// ─── TRADE DURATION MUTAGEN ──────────────────────────────────────────────────

export function tradeDurationMutagen(durationSeconds: number): number {
  if (durationSeconds < 10) return 0;
  return Math.min(0.05, ((durationSeconds - 10) / (72 * 3600 - 10)) * 0.05);
}

// ─── FULL FORMULA ─────────────────────────────────────────────────────────────

export interface MutagenInput {
  sizeUsd:         number;
  profitUsd:       number;  // profit_usd from ClosePositionEvent ÷ 1_000_000
  lossUsd:         number;  // loss_usd   from ClosePositionEvent ÷ 1_000_000
  durationSeconds: number;
}

export function computeMutagen(input: MutagenInput): number {
  if (input.sizeUsd <= 0) return 0;
  const netPnl      = input.profitUsd - input.lossUsd;
  const performance = tradePerformanceMutagen(input.sizeUsd, netPnl);
  const duration    = tradeDurationMutagen(input.durationSeconds);
  const sizeMult    = sizeMultiplier(input.sizeUsd);
  return (performance + duration) * sizeMult;
}

export function applyMissionBonus(baseMutagen: number, bonusMultiplier: number): number {
  return baseMutagen * Math.min(bonusMultiplier, 3.105);
}

export function microUsdToUsd(microUsd: bigint | number): number {
  return Number(microUsd) / 1_000_000;
}
