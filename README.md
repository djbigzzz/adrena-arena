# Adrena Arena

Mission-based competition layer for Adrena, built for the [Adrena x Autonom Superteam Earn Bounty](https://earn.superteam.fun/listing/adrena-x-autonom-trading-competition-design-and-development/).

**Live demo:** https://lustrous-treacle-bd3093.netlify.app

---

## What It Is

Adrena Arena adds a mission layer on top of Adrena's existing Mutagen scoring system. Traders complete time-boxed missions that award Mutagen multiplier bonuses applied to their next closed position — directly boosting their leaderboard score.

The system connects to Adrena's competition data service via WebSocket, receives real-time `close_position` events, and scores them using the exact Size Multiplier formula confirmed by the Adrena team.

---

## Structure

```
src/
  arena-indexer.ts          WebSocket consumer — connects to Adrena competition service
  arena-mutagen.ts          Exact Size Multiplier table + performance/duration formula
  arena-mission-engine.ts   10 missions, bonus queue, cycle resets, abuse prevention
  arena-api-routes.ts       REST API for frontend
  arena-schema.sql          PostgreSQL schema

tests/
  arena-mutagen.test.ts         34 formula tests (verified against Adrena API)
  arena-mission-engine.test.ts  30 mission engine tests

deploy/
  index.html                Self-contained live demo — drag to netlify.com/drop

docs/
  adrena-arena-design-doc.docx     Full competition design document
  adrena-arena-test-results.docx   Testing & feedback report
```

---

## Quick Start

```bash
cp .env.example .env
# Fill in DATABASE_URL and ADRENA_API_KEY in .env

npm install
npm test              # Run 64 unit tests
npm run indexer       # Start WebSocket indexer
npm run api           # Start REST API
```

For the live demo: open `deploy/index.html` in a browser, or drag it to [netlify.com/drop](https://app.netlify.com/drop).

---

## Formula

```
Mutagen = (Trade Performance + Trade Duration) × Size Multiplier × Mission Bonus
```

**Size Multiplier** (exact, from Adrena competition API):

| Size Range | Multiplier |
|---|---|
| $10 – $1K | 0.00025× – 0.05× |
| $1K – $5K | 0.05× – 1× |
| $5K – $50K | 1× – 5× |
| $50K – $100K | 5× – 9× |
| $100K – $250K | 9× – 17.5× |
| $250K – $500K | 17.5× – 25× |
| $500K – $1M | 25× – 30× |
| $1M – $4.5M | 30× – 45× |

Linear interpolation within each tier. Verified: $75K → 7× (matches Adrena guide example).

**Mission Bonus:** multipliers stack multiplicatively, capped at 3.105× (Daily 1.15× × Weekly 1.35× × Elite 2.00×).

---

## Integration

Connects to the Adrena competition data service provided by the Adrena team:

- `wss://adrena-competition-service.onrender.com/<API_KEY>` — real-time trade stream
- `GET /<API_KEY>/size-multiplier` — exact lookup table
- `GET /<API_KEY>/position-schema` — Position PDA layout

Message format:
```json
{
  "type": "close_position",
  "decoded": {
    "owner": "97ZYQ...",
    "side": "Long",
    "sizeUsd": "$164.535338",
    "profitUsd": "$1.068799",
    "lossUsd": "$0.00",
    "netPnl": "$1.068799"
  }
}
```

---

## Tests

```
64 tests passing (Vitest)

Formula (34):
  sizeMultiplier     11 — exact table, linear interpolation, $75K→7× verified
  tradePerformance    6 — 7.5% PnL→0.3, minimum thresholds
  tradeDuration       4 — 72h→0.05, linear scaling
  computeMutagen      5 — full formula integration
  missionBonus        5 — multiplicative stacking, 3.105× cap
  edgeCases           3 — zero size, liquidation→0

Mission Engine (30):
  definitions         7 — 10 missions, unique IDs
  bonusConsumption    4 — multiplicative, marked used after consume
  conditions         12 — all 8 mission types
  cycleResets         3 — daily UTC midnight, weekly Monday
  abusePrevention     4 — min sizes, expiry windows
```
