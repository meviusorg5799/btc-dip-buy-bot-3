/**
 * Dip-buy mean-reversion bot for the cbBTC/USDC 24h race.
 *
 * Protocol: agent-fun/bars-replay/v1, spoken through the kit shim in
 * vendor/makefun-bars.ts. The bot reads one hello, then one batch per
 * minute bar, and answers every batch with exactly one reply echoing
 * its seq. It is fully deterministic: no wall clock, no network, no
 * files outside the repo, no randomness at all.
 *
 * Strategy, in brief: bitcoin swings a few percent inside a day while
 * its one-minute noise is only a few basis points, so a trade has to
 * catch a swing, not a wiggle. The bot buys dips in tranches as price
 * falls away from its trailing 120-bar high, and sells back in stages
 * as price reverts toward and past the average entry. A second, faster
 * layer trades small dips against a 30-bar EMA while the book is flat,
 * so the bot keeps working between the big swings. Long only, never
 * more than the cash on hand, one open position, at most one order
 * per batch.
 */

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tuning knobs (basis points unless noted) -------------------------
const HIGH_WINDOW = 120; // bars of trailing high used as the dip reference
const EMA_WINDOW = 30; // bars of the fast EMA used by the scalp layer
const BUY_RUNGS_BPS = [60, 120, 180, 250]; // dip vs trailing high per ladder rung
const RUNG_FRACTION = 25n; // percent of equity spent per ladder rung (of 100)
const MIN_BARS_BETWEEN_BUYS = 3;
const SELL_STAGES: Array<[number, number]> = [
  [60, 25],
  [110, 25],
  [170, 25],
  [240, 100],
]; // [gain vs avg entry in bps, percent of position sold]
const STOP_BPS = 300; // sell everything this far below the average entry
const HOLD_CAP_BARS = 720; // sell everything once the position is this old
const SCALP_DIP_BPS = 15; // dip vs fast EMA that opens a scalp trade
const SCALP_FRACTION = 15n; // percent of equity spent on a scalp buy
const SCALP_TARGET_BPS = 30; // gain vs entry that closes a scalp trade
const SCALP_STOP_BPS = 60; // loss vs entry that closes a scalp trade
const SCALP_CAP_BARS = 120; // scalp age in bars that forces a close
const MAX_SLIPPAGE_BPS = 150;
const MIN_NOTIONAL = 1_000_000n; // 1 USDC, in quote units


/** The bot's own view of its position, kept from the bars it saw. */
const book = {
  closes: [] as bigint[],
  ema: 0n,
  emaSeen: false,
  mode: null as 'ladder' | 'scalp' | null,
  rung: 0, // ladder rungs already bought
  stage: 0, // sell stages already taken
  lastBuyBar: -1_000_000_000,
  positionStart: -1, // bar index the current position opened
};

function noteClose(close: bigint): void {
  book.closes.push(close);
  if (!book.emaSeen) {
    book.ema = close;
    book.emaSeen = true;
  } else {
    // EMA with integer math: ema += (close - ema) * 2 / (N + 1).
    book.ema += ((close - book.ema) * 2n) / BigInt(EMA_WINDOW + 1);
  }
}

function trailingHigh(): bigint | null {
  const window = book.closes.slice(-HIGH_WINDOW);
  if (window.length === 0) return null;
  let high = window[0]!;
  for (const c of window) if (c > high) high = c;
  return high;
}

function flatten(): void {
  book.mode = null;
  book.rung = 0;
  book.stage = 0;
  book.positionStart = -1;
}

function buyOrder(state: BarsState, notional: bigint): OrderInput | null {
  if (notional < MIN_NOTIONAL) return null;
  if (notional > state.cash) notional = state.cash;
  if (notional < MIN_NOTIONAL) return null;
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

function sellOrder(state: BarsState, percent: number): OrderInput | null {
  const holding = state.positions.get(SYMBOL);
  if (holding === undefined || holding.qty <= 0n) return null;
  const qty = percent >= 100 ? holding.qty : (holding.qty * BigInt(percent)) / 100n;
  if (qty <= 0n) return null;
  return { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

/** Effective average entry price (raw price units, fees included). */
function avgEntryRaw(state: BarsState): bigint | null {
  const holding = state.positions.get(SYMBOL);
  if (holding === undefined || holding.qty <= 0n) return null;
  const info = state.symbols.get(SYMBOL)!;
  const scale = 10n ** BigInt(info.qty_scale + info.price_scale - state.hello.capital.quote_scale);
  return (holding.cost * scale) / holding.qty;
}


function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  if (state.warmingUp) return [];
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return [];
  const close = BigInt(bar.c);
  const barIndex = state.seq;
  noteClose(close);

  const high = trailingHigh();
  if (high === null || !book.emaSeen || book.closes.length < HIGH_WINDOW) return [];

  const dipHighBps = Number(((high - close) * 10_000n) / high);
  const dipEmaBps = book.ema > close ? Number(((book.ema - close) * 10_000n) / book.ema) : 0;
  const holding = state.positions.get(SYMBOL);
  const held = holding !== undefined && holding.qty > 0n;

  if (held) {
    const entry = avgEntryRaw(state);
    const gainBps = entry === null ? 0 : Number(((close - entry) * 10_000n) / entry);
    const age = book.positionStart < 0 ? 0 : barIndex - book.positionStart;
    // Hard exits first: stop loss, then the holding cap.
    if (gainBps <= -STOP_BPS || age >= HOLD_CAP_BARS) {
      const order = sellOrder(state, 100);
      if (order === null) return [];
      flatten();
      return [order];
    }
    if (book.mode === 'scalp') {
      // A scalp closes on its target, on reversion to the EMA, or on
      // its stop; a deep dip converts it into a ladder instead.
      if (gainBps >= SCALP_TARGET_BPS || close >= book.ema || gainBps <= -SCALP_STOP_BPS || age >= SCALP_CAP_BARS) {
        const order = sellOrder(state, 100);
        if (order === null) return [];
        flatten();
        return [order];
      }
      if (dipHighBps >= BUY_RUNGS_BPS[0]!) {
        book.mode = 'ladder';
        book.rung = 1;
        book.stage = 0;
      }
    } else {
      // Ladder exits, stage by stage, as the price reverts.
      if (book.stage < SELL_STAGES.length && gainBps >= SELL_STAGES[book.stage]![0]) {
        const percent = SELL_STAGES[book.stage]![1];
        const order = sellOrder(state, percent);
        if (order === null) return [];
        book.stage += 1;
        if (percent >= 100) flatten();
        return [order];
      }
    }
    // Scale in while the dip deepens past the next rung.
    if (book.mode === 'ladder' && book.rung < BUY_RUNGS_BPS.length) {
      if (dipHighBps >= BUY_RUNGS_BPS[book.rung]! && barIndex - book.lastBuyBar >= MIN_BARS_BETWEEN_BUYS) {
        const order = buyOrder(state, (state.equity * RUNG_FRACTION) / 100n);
        if (order === null) return [];
        book.rung += 1;
        book.lastBuyBar = barIndex;
        return [order];
      }
    }
    return [];
  }

  // Flat: open a ladder on a deep dip, else a scalp on a small one.
  if (dipHighBps >= BUY_RUNGS_BPS[0]!) {
    const order = buyOrder(state, (state.equity * RUNG_FRACTION) / 100n);
    if (order === null) return [];
    book.mode = 'ladder';
    book.rung = 1;
    book.stage = 0;
    book.positionStart = barIndex;
    book.lastBuyBar = barIndex;
    return [order];
  }
  if (dipEmaBps >= SCALP_DIP_BPS) {
    const order = buyOrder(state, (state.equity * SCALP_FRACTION) / 100n);
    if (order === null) return [];
    book.mode = 'scalp';
    book.rung = 0;
    book.stage = 0;
    book.positionStart = barIndex;
    book.lastBuyBar = barIndex;
    return [order];
  }
  return [];
}

await runBars({ onBatch });
