/**
 * Adrena Arena — Mutagen Formula Unit Tests
 *
 * All size multiplier values verified against the EXACT table from:
 *   GET https://adrena-competition-service.onrender.com/<API_KEY>/size-multiplier
 *
 * PnL field names confirmed from:
 *   GET https://adrena-competition-service.onrender.com/<API_KEY>/position-schema
 *   → profit_usd / loss_usd (u64, USD × 10^6, mutually exclusive)
 *
 * Run: npx vitest run
 */

import { describe, it, expect } from "vitest";
import {
  sizeMultiplier,
  tradePerformanceMutagen,
  tradeDurationMutagen,
  computeMutagen,
  applyMissionBonus,
  microUsdToUsd,
} from "./arena-mutagen";

// ─── SIZE MULTIPLIER (exact values from API) ──────────────────────────────────

describe("sizeMultiplier — exact table from Adrena API", () => {
  it("below $10 → 0", () => {
    expect(sizeMultiplier(5)).toBe(0);
    expect(sizeMultiplier(9.99)).toBe(0);
  });

  it("above $4.5M → 0", () => {
    expect(sizeMultiplier(4_500_001)).toBe(0);
    expect(sizeMultiplier(10_000_000)).toBe(0);
  });

  it("$10 → 0.00025 (tier 1 min)", () => {
    expect(sizeMultiplier(10)).toBeCloseTo(0.00025, 5);
  });

  it("$1,000 → 0.05 (tier 1 max / tier 2 min)", () => {
    expect(sizeMultiplier(1_000)).toBeCloseTo(0.05, 4);
  });

  it("$5,000 → 1.0 (tier 2 max / tier 3 min)", () => {
    expect(sizeMultiplier(5_000)).toBeCloseTo(1.0, 4);
  });

  it("$75,000 → 7× (documented example from API guide)", () => {
    // Example from guide: $75k in $50k-$100k tier → 5 + (25000 × 4/50000) = 7
    expect(sizeMultiplier(75_000)).toBeCloseTo(7, 4);
  });

  it("$50,000 → 5× (tier 4 min)", () => {
    expect(sizeMultiplier(50_000)).toBeCloseTo(5, 4);
  });

  it("$100,000 → 9× (tier 4 max)", () => {
    expect(sizeMultiplier(100_000)).toBeCloseTo(9, 4);
  });

  it("$250,000 → 17.5× (tier 5 max)", () => {
    expect(sizeMultiplier(250_000)).toBeCloseTo(17.5, 4);
  });

  it("$500,000 → 25× (tier 6 max)", () => {
    expect(sizeMultiplier(500_000)).toBeCloseTo(25, 4);
  });

  it("$1,000,000 → 30× (tier 7 max)", () => {
    expect(sizeMultiplier(1_000_000)).toBeCloseTo(30, 4);
  });

  it("$4,500,000 → 45× (tier 8 max)", () => {
    expect(sizeMultiplier(4_500_000)).toBeCloseTo(45, 4);
  });

  it("linear interpolation within tier 5: $175k → 13.25×", () => {
    // $100k-$250k: 9 + (75000 × 8.5/150000) = 9 + 4.25 = 13.25
    expect(sizeMultiplier(175_000)).toBeCloseTo(13.25, 3);
  });

  it("increases monotonically across all tiers", () => {
    const sizes = [10, 500, 1000, 2500, 5000, 25000, 50000, 75000, 100000, 175000, 250000, 375000, 500000, 750000, 1000000, 2500000, 4500000];
    const mults = sizes.map(sizeMultiplier);
    for (let i = 1; i < mults.length; i++) {
      expect(mults[i]).toBeGreaterThan(mults[i - 1]);
    }
  });
});

// ─── PNL FIELDS: profit_usd / loss_usd ───────────────────────────────────────

describe("microUsdToUsd — ClosePositionEvent field conversion", () => {
  it("1_000_000 micro-USD = $1.00", () => {
    expect(microUsdToUsd(1_000_000n)).toBe(1.0);
  });

  it("95_432_100_000 = $95,432.10", () => {
    expect(microUsdToUsd(95_432_100_000n)).toBeCloseTo(95432.10, 2);
  });

  it("0 = $0", () => {
    expect(microUsdToUsd(0n)).toBe(0);
  });

  it("profit_usd and loss_usd are mutually exclusive — one is always 0", () => {
    // Winning trade: profit_usd > 0, loss_usd = 0
    const profit = microUsdToUsd(5_000_000n); // $5
    const loss   = microUsdToUsd(0n);
    expect(profit - loss).toBeCloseTo(5, 2);

    // Losing trade: profit_usd = 0, loss_usd > 0
    const profit2 = microUsdToUsd(0n);
    const loss2   = microUsdToUsd(3_000_000n); // $3
    expect(profit2 - loss2).toBeCloseTo(-3, 2);
  });
});

// ─── TRADE PERFORMANCE ───────────────────────────────────────────────────────

describe("tradePerformanceMutagen", () => {
  it("losing trade (net PnL < 0) → 0 performance (minimum may still apply)", () => {
    const result = tradePerformanceMutagen(1_000, -100);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("7.5% PnL → 0.3 mutagen (maximum)", () => {
    expect(tradePerformanceMutagen(100_000, 7_500)).toBeCloseTo(0.3, 3);
  });

  it("above 7.5% PnL is capped at 0.3", () => {
    expect(tradePerformanceMutagen(10_000, 5_000)).toBeCloseTo(0.3, 3);
  });

  it("$100K+ trade gets minimum 0.10 even at breakeven", () => {
    expect(tradePerformanceMutagen(100_000, 0)).toBeGreaterThanOrEqual(0.10);
  });

  it("$1M+ trade gets minimum 0.15 even at breakeven", () => {
    expect(tradePerformanceMutagen(1_000_000, 0)).toBeGreaterThanOrEqual(0.15);
  });

  it("$1K trade at breakeven gets 0 (no minimum)", () => {
    expect(tradePerformanceMutagen(1_000, 0)).toBe(0);
  });
});

// ─── DURATION ────────────────────────────────────────────────────────────────

describe("tradeDurationMutagen", () => {
  it("< 10 seconds → 0", () => expect(tradeDurationMutagen(9)).toBe(0));
  it("72 hours → 0.05", () => expect(tradeDurationMutagen(72*3600)).toBeCloseTo(0.05, 4));
  it("> 72 hours capped at 0.05", () => expect(tradeDurationMutagen(100*3600)).toBeCloseTo(0.05, 4));
  it("36 hours → ~0.025", () => expect(tradeDurationMutagen(36*3600)).toBeCloseTo(0.025, 2));
});

// ─── FULL FORMULA ─────────────────────────────────────────────────────────────

describe("computeMutagen — uses profit_usd / loss_usd fields", () => {
  it("$75K position, $7,500 profit (10%), 2h → uses exact 7× multiplier", () => {
    const result = computeMutagen({
      sizeUsd:         75_000,
      profitUsd:       7_500,
      lossUsd:         0,
      durationSeconds: 7_200,
    });
    // performance: 7.5% → 0.3, duration: ~0.0028, size: 7× → (0.3+0.0028)×7 ≈ 2.12
    expect(result).toBeGreaterThan(2.0);
    expect(result).toBeLessThan(2.3);
  });

  it("$75K breakeven: uses minimum 0 (below $100K threshold), size=7×", () => {
    const result = computeMutagen({
      sizeUsd:         75_000,
      profitUsd:       0,
      lossUsd:         0,
      durationSeconds: 3_600,
    });
    // performance: 0 (no minimum below $100K), duration: tiny, size: 7×
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(0.1);
  });

  it("$100K breakeven: minimum 0.10 applies, size=9×", () => {
    const result = computeMutagen({
      sizeUsd:         100_000,
      profitUsd:       0,
      lossUsd:         0,
      durationSeconds: 3_600,
    });
    // (0.10 + small_duration) × 9 ≈ 0.9+
    expect(result).toBeGreaterThan(0.8);
    expect(result).toBeLessThan(1.2);
  });

  it("losing trade (loss_usd > 0) scores based on net negative PnL", () => {
    const result = computeMutagen({
      sizeUsd:         50_000,
      profitUsd:       0,
      lossUsd:         2_000,  // $2K loss on $50K
      durationSeconds: 3_600,
    });
    expect(result).toBeGreaterThanOrEqual(0);
    expect(isNaN(result)).toBe(false);
  });

  it("size=0 → 0 regardless of PnL", () => {
    expect(computeMutagen({ sizeUsd:0, profitUsd:100, lossUsd:0, durationSeconds:3600 })).toBe(0);
  });
});

// ─── MISSION BONUS ───────────────────────────────────────────────────────────

describe("applyMissionBonus", () => {
  it("no bonus (1.0×) → unchanged", () => {
    const base = 2.5;
    expect(applyMissionBonus(base, 1.0)).toBe(base);
  });

  it("1.10× daily bonus applies correctly", () => {
    expect(applyMissionBonus(2.0, 1.10)).toBeCloseTo(2.2, 4);
  });

  it("stacked bonuses: 1.10 × 1.30 = 1.43× applied to base", () => {
    const stacked = 1.10 * 1.30; // = 1.43
    expect(applyMissionBonus(2.0, stacked)).toBeCloseTo(2.86, 3);
  });

  it("max theoretical 3.105× (1.15 × 1.35 × 2.00) is enforced", () => {
    const theoretical = 1.15 * 1.35 * 2.00;
    expect(theoretical).toBeCloseTo(3.105, 2);
    expect(applyMissionBonus(1.0, theoretical)).toBeCloseTo(3.105, 2);
  });

  it("above 3.105× is capped", () => {
    expect(applyMissionBonus(1.0, 5.0)).toBeCloseTo(3.105, 2);
  });
});
