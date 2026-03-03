<div align="center">

<img src="https://app.adrena.xyz/images/logo.png" width="80" alt="Adrena Logo"/>

# ADRENA ARENA

**Mission-Based Trading Competition Layer for Adrena**

[![Live Demo](https://img.shields.io/badge/LIVE%20DEMO-adrena--arena.netlify.app-00d4a1?style=for-the-badge&logoColor=white)](https://adrena-arena.netlify.app)
[![Bounty](https://img.shields.io/badge/Superteam%20Earn-Adrena%20x%20Autonom-c8a84b?style=for-the-badge)](https://earn.superteam.fun/listing/adrena-x-autonom-trading-competition-design-and-development/)
[![TypeScript](https://img.shields.io/badge/TypeScript-85%25-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/Tests-64%20passing-22c55e?style=for-the-badge)](tests/)

*Superteam Ireland · March 2026 ·*
Galin Dimitrov
---

**[View Live Demo](https://adrena-arena.netlify.app)** &nbsp;·&nbsp; **[Design Doc](docs/adrena-arena-design-doc.docx)** &nbsp;·&nbsp; **[Test Report](docs/adrena-arena-test-results.docx)**

</div>

---

## What Is Adrena Arena?

50% of Adrena's 2025 trading volume came from competitions. The problem: every perp DEX runs the same format — a leaderboard that 99% of traders will never top. After day one, engagement dies.

**Arena fixes this.** It adds a mission layer on top of Adrena's existing Mutagen scoring system. Traders complete time-boxed missions that award **Mutagen multiplier bonuses** applied to their next closed position — directly boosting their leaderboard score. Every trader has personal progress to chase, regardless of wallet size.

```
Complete missions  ->  earn Mutagen multipliers  ->  bonuses apply to next trade  ->  leaderboard grows faster
```

> Zero changes to Adrena's on-chain program. Pure off-chain layer connecting to the same
> ClosePositionEvent stream already used for Mutagen scoring.

---

## Live Demo

**[adrena-arena.netlify.app](https://adrena-arena.netlify.app)**

| Tab | What you will see |
|-----|----------------|
| **Live Feed** | Real-time trade stream from Adrena's competition service |
| **Leaderboard** | Ranked by total Mutagen, updates on every close |
| **Arena Missions** | 10 missions across Daily / Weekly / Elite tiers |
| **Battle Pass** | Season 1 progression, 8 tiers, XP and rewards |
| **My Stats** | Season Mutagen, day streak, session PnL chart |

Toggle between **LIVE** (real Adrena WebSocket) and **DEMO** (simulated trades) using the toggle in the tab bar.

---

## The System

### Mutagen Formula

```
Final Mutagen = (Trade Performance + Trade Duration) x Size Multiplier x Mission Bonus
```

### Size Multiplier — Exact Table

Confirmed directly from the Adrena team via `GET /<API_KEY>/size-multiplier`. Linear interpolation within each tier.

| Close Size | Multiplier Range |
|-----------|-----------------|
| $10 - $1K | 0.00025x - 0.05x |
| $1K - $5K | 0.05x - 1x |
| $5K - $50K | 1x - 5x |
| $50K - $100K | 5x - 9x |
| $100K - $250K | 9x - 17.5x |
| $250K - $500K | 17.5x - 25x |
| $500K - $1M | 25x - 30x |
| $1M - $4.5M | 30x - 45x |

Verified: $75,000 position = **7x** (matches the example in Adrena's official guide)

### Mission Bonus Stack

| Type | Missions | Bonus Range | Max Stack |
|------|---------|-------------|-----------|
| Daily | 4 missions, resets UTC midnight | 1.05x - 1.15x | |
| Weekly | 4 missions, resets Monday UTC | 1.20x - 1.35x | |
| Elite | 2 missions, season-long | 1.50x - 2.00x | |
| **Combined** | | | **3.105x** |

Bonuses stack **multiplicatively**: `1.15 x 1.35 x 2.00 = 3.105x`

---

## Missions

### Daily (Reset: UTC Midnight)

| Mission | Condition | Min Size | XP | Bonus |
|---------|-----------|----------|----|-------|
| First Blood | Close first position today | $500 | 50 | 1.05x |
| Volume Runner | Execute $2,500 notional today | $500 | 75 | 1.10x |
| Profit Lock | Close one position in profit | $500 | 100 | 1.15x |
| Night Owl | Trade 00:00-06:00 UTC | $1,000 | 60 | 1.08x |

### Weekly (Reset: Monday UTC)

| Mission | Condition | Min Size | XP | Bonus |
|---------|-----------|----------|----|-------|
| Diamond Hands | Hold profitable position 12+ hours | $1,000 | 250 | 1.25x |
| Street Fighter | Complete 15 trades this week | $500 each | 300 | 1.30x |
| Risk Manager | Attach stop-loss to 5 positions | Any | 200 | 1.20x |
| Contrarian | Short while >70% sentiment is long | $1,000 | 350 | 1.35x |

### Elite (Season-Long)

| Mission | Condition | XP | Bonus |
|---------|-----------|-----|-------|
| Century Club | $100K cumulative volume this season | 1,500 | 1.50x |
| Undefeated | Win 7 consecutive Gauntlet matchups | 2,000 | 2.00x |

---

## Battle Pass

8 tiers per season, driven by XP earned from missions.

| Tier | XP Required | Reward |
|------|-------------|--------|
| T1 Recruit | 0 | Arena access |
| T2 Fighter | 1,000 | Profile badge |
| T3 Veteran | 2,500 | ADX raffle entries +1/week |
| T4 Sniper | 4,000 | Exclusive cosmetic frame |
| T5 Elite | 6,000 | ADX staking boost +10% for season |
| T6 Diamond | 7,000 | Competition fee rebate 15% |
| T7 Champion | 9,000 | Exclusive Season 1 NFT badge |
| T8 Legend | 12,000 | Legend NFT + priority beta access |

---

## Gauntlet - Head-to-Head Mode

Optional bracket tournament (16 or 32 traders) running alongside the main leaderboard. Single-elimination matchups over 24-hour windows, scored on risk-adjusted performance — not raw PnL. A $5K trader can beat a $500K trader on skill.

---

## Architecture

```
Adrena on-chain program  (ClosePositionEvent)
              |
Adrena competition service  (WebSocket)
wss://adrena-competition-service.onrender.com/<API_KEY>
              |
   arena-indexer.ts  <-->  arena-mutagen.ts
              |                    |
 arena-mission-engine.ts     Size Multiplier (exact)
              |              Performance + Duration
   PostgreSQL  (arena-schema.sql)
              |
   arena-api-routes.ts  -->  Frontend  (deploy/index.html)
```

### WebSocket Message Format

```json
{
  "type": "close_position",
  "timestamp": 1709078400000,
  "decoded": {
    "owner": "97ZYQ...",
    "side": "Long",
    "sizeUsd": "$164.535338",
    "profitUsd": "$1.068799",
    "lossUsd": "$0.00",
    "netPnl": "$1.068799",
    "positionId": "110159"
  }
}
```

---

## File Reference

```
src/
  arena-indexer.ts          WebSocket consumer - connects to Adrena competition service
  arena-mutagen.ts          Exact Size Multiplier table + performance/duration formula
  arena-mission-engine.ts   10 missions, bonus queue, cycle resets, abuse prevention
  arena-api-routes.ts       REST API for frontend consumption
  arena-schema.sql          PostgreSQL schema: trades, mission state, leaderboard

tests/
  arena-mutagen.test.ts         34 formula tests - verified against Adrena API
  arena-mission-engine.test.ts  30 mission engine tests

deploy/
  index.html    Self-contained live demo - works in any browser, no build step

docs/
  adrena-arena-design-doc.docx     Full competition design document
  adrena-arena-test-results.docx   Testing and feedback report
```

---

## Quick Start

```bash
npm install
cp .env.example .env        # set DATABASE_URL and ADRENA_API_KEY
psql -f src/arena-schema.sql
npm test                    # run all 64 tests
npm run indexer             # start WebSocket indexer
npm run api                 # start REST API
```

For the frontend only: open `deploy/index.html` directly in a browser. No build step needed.

---

## Test Coverage

```
64 tests passing  (Vitest)

Formula Tests (34)
  sizeMultiplier      x11   Exact tier table, $75K -> 7x verified against API
  tradePerformance     x6   7.5% PnL -> 0.3, minimum thresholds correct
  tradeDuration        x4   72h -> 0.05, linear scaling confirmed
  computeMutagen       x5   Full integration, matches live Adrena calculator
  missionBonus         x5   Multiplicative stacking, 3.105x cap enforced
  edgeCases            x3   Zero size -> 0, liquidation -> 0 Mutagen

Mission Engine Tests (30)
  definitions          x7   10 missions present, IDs unique, bonuses >1.0
  bonusConsumption     x4   Marked used after consume, multiplicative stacking
  conditions          x12   All 8 mission types, time windows, thresholds
  cycleResets          x3   Daily=UTC midnight, Weekly=Monday UTC
  abusePrevention      x4   Min sizes enforced, bonus expiry windows
```

---

## Why Arena Beats the Competition

| Feature | dYdX | Drift | Hyperliquid | Adrena Arena |
|---------|------|-------|-------------|--------------|
| Daily engagement hook | No | No | No | 10 missions/day |
| Skill-based multipliers | No | No | No | Mission bonuses |
| Season progression | No | No | No | Battle Pass (8 tiers) |
| Retail-friendly scoring | No | No | No | Missions level the field |
| Head-to-head mode | No | No | No | Gauntlet brackets |
| Real-time trade feed | No | No | No | WebSocket live feed |

---

## Team Coordination

Built in direct coordination with the Adrena team via the Superteam Earn Discord ticket:

- **mcg26623** (Founder) - confirmed competition culture, creative brief, and new iteration context
- **br0wnD3v** (Dev) - built the competition data service, provided the exact Size Multiplier table, Position PDA schema, and pre-decoded WebSocket stream

---

<div align="center">

Built for the [Adrena x Autonom Superteam Earn Bounty](https://earn.superteam.fun/listing/adrena-x-autonom-trading-competition-design-and-development/) · March 2026

**[adrena-arena.netlify.app](https://adrena-arena.netlify.app)**

</div>
