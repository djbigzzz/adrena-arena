/**
 * Adrena Arena — Real-time Indexer
 *
 * Connects to the Adrena competition WebSocket service provided by br0wnD3v:
 *   wss://adrena-competition-service.onrender.com/<API_KEY>
 *
 * Streams live ClosePositionLong / ClosePositionShort transactions,
 * decodes the ClosePositionEvent from program logs, computes Mutagen,
 * evaluates missions, and persists to PostgreSQL.
 *
 * Run:
 *   API_KEY=4dr3n4-n0v3l-7r4ding-4nd-g4m3s-id34-b0un7y \
 *   DATABASE_URL=postgres://... \
 *   npx ts-node arena-indexer.ts
 */

import WebSocket from "ws";
import { Pool }  from "pg";
import { computeMutagen, applyMissionBonus, microUsdToUsd } from "./arena-mutagen";
import { MissionEngine } from "./arena-mission-engine";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const API_KEY      = process.env.API_KEY      ?? "4dr3n4-n0v3l-7r4ding-4nd-g4m3s-id34-b0un7y";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const WS_URL       = `wss://adrena-competition-service.onrender.com/${API_KEY}`;

// ─── CLOSE POSITION EVENT ─────────────────────────────────────────────────────
// Deserialized from "Program data: <base64>" log line.
// Field layout confirmed via GET /<API_KEY>/position-schema

interface ClosePositionEvent {
  owner:               string;   // Trader wallet (base58)
  position:            string;   // Position PDA
  side:                number;   // 1=Long, 2=Short
  size_usd:            bigint;   // USD × 10^6
  price:               bigint;   // Exit price × 10^6
  collateral_amount_usd: bigint;
  profit_usd:          bigint;   // Realized profit × 10^6 (0 if losing)
  loss_usd:            bigint;   // Realized loss   × 10^6 (0 if winning)
  borrow_fee_usd:      bigint;
  exit_fee_usd:        bigint;
  position_id:         bigint;
  percentage:          bigint;   // BPS: 1_000_000 = 100%
  funding_paid_usd:    bigint;
  funding_received_usd: bigint;
  pool_type:           number;   // 0=Token, 1=Synthetic
}

// ─── BORSH DESERIALIZATION ────────────────────────────────────────────────────
// ClosePositionEvent is borsh-serialized after an 8-byte discriminator.
// Fields are in the order documented in position-schema.

function parseClosePositionEvent(logLine: string): ClosePositionEvent | null {
  try {
    const b64 = logLine.replace("Program data: ", "");
    const buf = Buffer.from(b64, "base64");

    // Skip 8-byte discriminator
    let offset = 8;

    const readPubkey = () => {
      const pk = buf.slice(offset, offset + 32).toString("hex");
      offset += 32;
      return pk;
    };
    const readU8  = () => { const v = buf.readUInt8(offset);      offset += 1;  return v; };
    const readU64 = () => { const v = buf.readBigUInt64LE(offset); offset += 8;  return v; };

    return {
      owner:               readPubkey(),
      position:            readPubkey(),
      custody_mint:        readPubkey(), // skip — not needed for scoring
      custody_seed:        (() => { const v = buf.slice(offset, offset+32); offset+=32; return v.toString("hex"); })(),
      side:                readU8(),
      size_usd:            readU64(),
      price:               readU64(),
      collateral_amount_usd: readU64(),
      profit_usd:          readU64(),   // KEY FIELD — realized profit
      loss_usd:            readU64(),   // KEY FIELD — realized loss
      borrow_fee_usd:      readU64(),
      exit_fee_usd:        readU64(),
      position_id:         readU64(),
      percentage:          readU64(),
      funding_paid_usd:    readU64(),
      funding_received_usd: readU64(),
      pool_type:           readU8(),
    } as ClosePositionEvent;
  } catch {
    return null;
  }
}

// ─── POSITION OPEN TIME TRACKER ───────────────────────────────────────────────
// We track open_time from account updates so we can compute duration at close.
// Key: position PDA hex → open_time (unix seconds)

const openTimes = new Map<string, number>();

function decodePositionAccount(hexData: string): { positionKey: string; openTime: number } | null {
  try {
    const buf = Buffer.from(hexData, "hex");
    if (buf.length < 152) return null;
    // open_time is at offset 144 (i64 LE) — from position-schema docs
    const openTime    = Number(buf.readBigInt64LE(144));
    const positionKey = hexData.slice(0, 64); // use first 32 bytes as key (discriminator+bump+...)
    return { positionKey, openTime };
  } catch {
    return null;
  }
}

// ─── DATABASE ─────────────────────────────────────────────────────────────────

async function saveTradeEvent(db: Pool, engine: MissionEngine, params: {
  txSignature:     string;
  trader:          string;
  positionPda:     string;
  side:            number;
  sizeUsd:         number;
  profitUsd:       number;
  lossUsd:         number;
  exitFeeUsd:      number;
  durationSeconds: number;
  isLiquidation:   boolean;
  closeTimestamp:  number;
}) {
  const baseMutagen  = computeMutagen({
    sizeUsd:         params.sizeUsd,
    profitUsd:       params.profitUsd,
    lossUsd:         params.lossUsd,
    durationSeconds: params.durationSeconds,
  });

  // Liquidations score 0 Mutagen (no incentive to farm liquidations)
  const scoreableMutagen = params.isLiquidation ? 0 : baseMutagen;

  // Consume any active mission bonuses
  const missionBonus  = await engine.consumeActiveBonuses(params.trader);
  const finalMutagen  = applyMissionBonus(scoreableMutagen, missionBonus);

  await db.query(`
    INSERT INTO arena_trade_events (
      tx_signature, trader, position_pda, side,
      size_usd, profit_usd, loss_usd, exit_fee_usd,
      duration_seconds, is_liquidation, close_timestamp,
      base_mutagen, mission_bonus, final_mutagen
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($11),$12,$13,$14)
    ON CONFLICT (tx_signature) DO NOTHING
  `, [
    params.txSignature, params.trader, params.positionPda, params.side,
    params.sizeUsd, params.profitUsd, params.lossUsd, params.exitFeeUsd,
    params.durationSeconds, params.isLiquidation, params.closeTimestamp,
    scoreableMutagen, missionBonus, finalMutagen,
  ]);

  console.log(
    `[TRADE] ${params.trader.slice(0, 8)}... | ` +
    `$${params.sizeUsd.toLocaleString()} | ` +
    `PnL: ${(params.profitUsd - params.lossUsd) >= 0 ? "+" : ""}$${(params.profitUsd - params.lossUsd).toFixed(2)} | ` +
    `${params.durationSeconds}s | ` +
    `Base: ${scoreableMutagen.toFixed(4)} × ${missionBonus.toFixed(3)} = ${finalMutagen.toFixed(4)} Mutagen`
  );

  // Evaluate mission progress (non-blocking)
  engine.evaluateMissions(params.trader, {
    txSignature:     params.txSignature,
    trader:          params.trader,
    positionKey:     params.positionPda,
    side:            params.side === 1 ? "long" : "short",
    sizeUsd:         params.sizeUsd,
    pnlAfterFees:    params.profitUsd - params.lossUsd,
    openTimestamp:   params.closeTimestamp - params.durationSeconds,
    closeTimestamp:  params.closeTimestamp,
    isLiquidation:   params.isLiquidation,
    durationSeconds: params.durationSeconds,
  }).catch(console.error);
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────

async function main() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL env var required");

  const db     = new Pool({ connectionString: DATABASE_URL });
  const engine = new MissionEngine(db);

  console.log("Adrena Arena Indexer starting...");
  console.log(`WebSocket: ${WS_URL}`);

  function connect() {
    const ws = new WebSocket(WS_URL);

    ws.on("open", () => {
      console.log("✅ Connected to Adrena competition service");
    });

    ws.on("message", async (raw: Buffer) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // ── Account update: track open times ──
      if (msg.type === "account" && msg.filter === "positions" && msg.data?.data) {
        const decoded = decodePositionAccount(msg.data.data);
        if (decoded) {
          openTimes.set(msg.data.pubkey, decoded.openTime);
        }
        return;
      }

      // ── Transaction: detect close events ──
      if (msg.type !== "transaction" || !msg.data?.logs) return;

      const logs: string[] = msg.data.logs;
      const isClose = logs.some(l =>
        l.includes("ClosePositionLong") || l.includes("ClosePositionShort")
      );
      if (!isClose) return;

      // Find and decode the ClosePositionEvent
      const dataLine = logs.find(l => l.startsWith("Program data: "));
      if (!dataLine) return;

      const event = parseClosePositionEvent(dataLine);
      if (!event) {
        console.warn("Failed to parse ClosePositionEvent in tx:", msg.data.signature);
        return;
      }

      // Convert micro-USD to dollars
      const sizeUsd    = microUsdToUsd(event.size_usd);
      const profitUsd  = microUsdToUsd(event.profit_usd);
      const lossUsd    = microUsdToUsd(event.loss_usd);
      const exitFeeUsd = microUsdToUsd(event.exit_fee_usd);

      // Compute duration from tracked open time
      const closeTimestamp = Math.floor(msg.timestamp / 1000); // ms → seconds
      const openTime       = openTimes.get(event.position) ?? closeTimestamp;
      const durationSecs   = Math.max(0, closeTimestamp - openTime);

      // Detect liquidations from logs
      const isLiquidation = logs.some(l => l.includes("Liquidate"));

      await saveTradeEvent(db, engine, {
        txSignature:     msg.data.signature,
        trader:          event.owner,
        positionPda:     event.position,
        side:            event.side,
        sizeUsd,
        profitUsd,
        lossUsd,
        exitFeeUsd,
        durationSeconds: durationSecs,
        isLiquidation,
        closeTimestamp,
      });
    });

    ws.on("error", (err) => console.error("WS error:", err.message));

    ws.on("close", () => {
      console.warn("WebSocket closed. Reconnecting in 5s...");
      setTimeout(connect, 5000);
    });
  }

  connect();
}

main().catch(console.error);
