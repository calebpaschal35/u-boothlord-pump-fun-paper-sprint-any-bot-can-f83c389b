// Launch sniper for the pump.fun paper sprint.
//
// Watches every new curve from its CreateEvent. Inside the first few slots
// after creation it buys only when the launch looks honest: the creator has
// put at least 0.5 SOL of their own money in, at least six other wallets
// have already bought, the creator has not sold anything, and the real SOL
// in the curve is in a sane range. One shot per coin, ~0.3 SOL staked
// (capped at 1% of the real reserve, never below the 0.01 SOL round-trip
// floor). It gets out fast: +25% take-profit, -15% stop-loss, at most ~10
// slots held, and out at once the moment the creator sells.
//
// Fully deterministic: no clock, no environment, no randomness. stdout
// carries replies only; anything diagnostic goes to stderr.

import { LAMPORTS_PER_SOL, runBot, type OrderInput } from './vendor/makefun-bot.ts';

const LAM = 1_000_000_000; // lamports in one SOL, as a Number

// ---- tunables ----
const ENTRY_SLOTS = 10; // decide within this many slots of the CreateEvent
const CREATOR_MIN_SOL = 0.5; // creator's own buys must total at least this
const MIN_OTHER_BUYERS = 6; // distinct non-creator wallets that bought in
const REAL_MIN_SOL = 1; // real SOL must be at least this (1% cap >= 0.01 SOL)
const REAL_MAX_SOL = 50; // skip curves whose real SOL already ran past this
const TARGET_SOL = 0.3; // SOL to put into one position
const MIN_BUY_SOL = 0.01; // smallest buy worth sending (round-trip floor)
const BUY_SLIP_BPS = 1500; // slippage allowed on buys
const SELL_SLIP_BPS = 10000; // sells always go out wide open
const STOP_LOSS = 0.85; // sell when value <= cost * 0.85
const HOLD_SLOTS = 10; // sell once held this many slots
const TAKE_PROFIT = 1.25; // sell when value >= cost * 1.25
const CURVE_FEE = 0.0125; // 95bps protocol + 30bps creator

interface Launch {
  creator: string;
  born: number; // slot of the CreateEvent (-1 when first seen via a trade)
  creatorBuy: number; // SOL the creator has bought
  creatorSold: boolean;
  buyers: Set<string>; // distinct non-creator wallets that bought
  settled: boolean; // entry decision already made (bought or passed)
}

interface Held {
  since: number; // slot the position first showed up in state
}

const launches = new Map<string, Launch>();
const held = new Map<string, Held>();

/** SOL a position would bring back if sold into the curve right now. */
function sellValue(
  virtualQuote: bigint,
  virtualToken: bigint,
  tokens: bigint,
  txFeeSol: number,
): number {
  const vq = Number(virtualQuote);
  const vt = Number(virtualToken);
  const t = Number(tokens);
  if (vt <= 0 || t <= 0) return 0;
  const outSol = (t * vq) / (vt + t) / LAM;
  return outSol * (1 - CURVE_FEE) - txFeeSol;
}

await runBot({
  onBatch(state, batch) {
    const slot = batch.slot;
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const txFee = state.txFeeLamports();
    const txSol = Number(txFee) / LAM;
    let cashLeft = state.freeCashLamports();

    // --- fold this batch's events into the launch notes ---
    const touched = new Set<string>();
    for (const ev of batch.events) {
      if (ev.event === 'CreateEvent') {
        let rec = launches.get(ev.mint);
        if (rec === undefined) {
          rec = {
            creator: ev.creator,
            born: ev.slot,
            creatorBuy: 0,
            creatorSold: false,
            buyers: new Set(),
            settled: false,
          };
          launches.set(ev.mint, rec);
        } else {
          rec.creator = ev.creator;
          rec.born = ev.slot;
        }
        touched.add(ev.mint);
      } else if (ev.event === 'TradeEvent') {
        let rec = launches.get(ev.mint);
        if (rec === undefined) {
          rec = {
            creator: ev.creator,
            born: -1,
            creatorBuy: 0,
            creatorSold: false,
            buyers: new Set(),
            settled: false,
          };
          launches.set(ev.mint, rec);
        }
        const sol = Number(ev.sol_amount) / LAM;
        if (ev.user === rec.creator) {
          if (ev.is_buy) rec.creatorBuy += sol;
          else rec.creatorSold = true;
        } else if (ev.is_buy) {
          rec.buyers.add(ev.user);
        }
        touched.add(ev.mint);
      }
    }

    // --- track which positions are still open, and when each appeared ---
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }
    for (const mint of state.positions.keys()) {
      if (!held.has(mint)) held.set(mint, { since: slot });
    }

    // --- exits first: take-profit, stop-loss, max hold, creator sold ---
    const selling = new Set<string>();
    for (const po of state.pending.values()) {
      if (po.order.side === 'sell') selling.add(po.order.mint);
    }
    for (const [mint, h] of held) {
      if (orders.length >= cap) break;
      if (selling.has(mint)) continue;
      const pos = state.positions.get(mint);
      if (pos === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const cost = Number(pos.cost_lamports) / LAM;
      const value = sellValue(
        curve.virtual_quote_reserves,
        curve.virtual_token_reserves,
        pos.token_amount,
        txSol,
      );
      const rec = launches.get(mint);
      const creatorDumped = rec !== undefined && rec.creatorSold;
      const tooOld = slot - h.since >= HOLD_SLOTS;
      if (value >= cost * TAKE_PROFIT || value <= cost * STOP_LOSS || tooOld || creatorDumped) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SELL_SLIP_BPS,
        });
        selling.add(mint);
      }
    }

    // --- entries: fresh launches that pass every filter, one shot each ---
    const buying = new Set<string>();
    for (const po of state.pending.values()) {
      if (po.order.side === 'buy') buying.add(po.order.mint);
    }
    for (const mint of touched) {
      if (orders.length >= cap) break;
      const rec = launches.get(mint);
      if (rec === undefined || rec.settled) continue;
      // Only coins whose birth we actually saw, still inside the entry window.
      if (rec.born < 0 || slot - rec.born > ENTRY_SLOTS) {
        rec.settled = true;
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (rec.creatorBuy < CREATOR_MIN_SOL) continue;
      if (rec.buyers.size < MIN_OTHER_BUYERS) continue;
      if (rec.creatorSold) continue;
      const realSol = Number(curve.real_quote_reserves) / LAM;
      if (realSol < REAL_MIN_SOL || realSol > REAL_MAX_SOL) continue;
      if (state.positions.has(mint) || buying.has(mint)) continue;
      if (state.committedPositionCount() >= state.hello.caps.max_open_positions) continue;
      const sizeCap = state.maxBuyLamports(mint);
      const target = BigInt(Math.floor(TARGET_SOL * LAM));
      let amount = target < sizeCap ? target : sizeCap;
      const affordable = cashLeft - txFee;
      if (amount > affordable) amount = affordable;
      if (amount < BigInt(Math.floor(MIN_BUY_SOL * LAM))) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIP_BPS,
      });
      buying.add(mint);
      cashLeft -= amount + txFee;
      rec.settled = true;
    }

    return orders;
  },
});
