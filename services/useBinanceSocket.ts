import { useEffect, useRef, useState } from 'react';
import { AppState, AggTradeEvent, DepthEvent, MiniTickerEvent, TradeItem, OrderBookLevel, OrderFlowMetrics } from '../types';
import {
    calculateOBI,
    calculateDeepOBI,
    calculateRollingDelta,
    calculateZScore,
    calculateLinearRegressionSlope,
    calculateAbsorption,
    calculateRegime,
    calculateSweepFade,
    calculateBreakout
} from './mathUtils';
import { OrderBookEngine } from './OrderBookEngine';

const BINANCE_STREAM_URL = 'wss://fstream.binance.com/stream';

// Debug config
const DEBUG_ALL_SYMBOLS = false;
const DEBUG_SYMBOLS: string[] = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']; // Configurable
const debugThrottleMap = new Map<string, number>();

// Price source enum for diagnostics
type PriceSource = 'trade' | 'mid' | 'lastGood' | 'ticker' | 'none';

// --- internal tracking structures per symbol ---
interface SymbolTracker {
    engine: OrderBookEngine;
    tradeQueue: TradeItem[];
    cvdHistory: number[];
    delta1sHistory: number[];
    priceHistory: number[];

    // Accumulators
    cvd: number;
    totalVolume: number;
    totalNotional: number;
    vwap: number;
    high: number;
    low: number;
    lastPrice: number;
    tickerClose: number; // From miniTicker

    // P1: Server time reference for clock skew fix
    lastServerTime: number;

    // LastGood cache for flicker prevention (book-based only)
    lastGoodBids: OrderBookLevel[];
    lastGoodAsks: OrderBookLevel[];
    lastGoodObiWeighted: number;
    lastGoodObiSpoof: number;
    lastGoodAt: number;
}

const createTracker = (symbol: string): SymbolTracker => ({
    engine: new OrderBookEngine(symbol),
    tradeQueue: [],
    cvdHistory: [],
    delta1sHistory: [],
    priceHistory: [],
    cvd: 0,
    totalVolume: 0,
    totalNotional: 0,
    vwap: 0,
    high: 0,
    low: 0,
    lastPrice: 0,
    tickerClose: 0,
    lastServerTime: 0,
    // LastGood cache init (book-based only)
    lastGoodBids: [],
    lastGoodAsks: [],
    lastGoodObiWeighted: 0,
    lastGoodObiSpoof: 0,
    lastGoodAt: 0
});

export const useBinanceSocket = (activeSymbols: string[]) => {
    const [data, setData] = useState<AppState>({});

    // Refs to hold mutable state without re-rendering
    const trackers = useRef<Map<string, SymbolTracker>>(new Map());
    const socketRef = useRef<WebSocket | null>(null);

    // Snapshot scheduling queue: ensures only one snapshot is in flight across all symbols
    // to avoid concurrent REST calls that may trigger rate limits. Symbols needing
    // snapshots are enqueued and processed sequentially.
    const snapshotQueueRef = useRef<string[]>([]);
    const snapshotInProgressRef = useRef<boolean>(false);

    // Helper to get or create tracker
    const getTracker = (symbol: string) => {
        if (!trackers.current.has(symbol)) {
            const t = createTracker(symbol);
            // Do not call initSnapshot here to avoid concurrent snapshot
            // attempts across multiple symbols. Instead, mark the engine as
            // needing resync; the snapshot scheduler below will pick it up.
            // A new engine starts with needsResync=true by default.
            trackers.current.set(symbol, t);
        }
        return trackers.current.get(symbol)!;
    };

    useEffect(() => {
        if (activeSymbols.length === 0) return;

        // Cleanup old trackers
        Array.from(trackers.current.keys()).forEach(key => {
            if (!activeSymbols.includes(key)) trackers.current.delete(key);
        });

        // Initialize new ones
        activeSymbols.forEach(s => getTracker(s));

        // Connect WS
        const streams = activeSymbols.flatMap(s => {
            const lower = s.toLowerCase();
            return [`${lower}@aggTrade`, `${lower}@depth@100ms`, `${lower}@miniTicker`];
        }).join('/');

        const ws = new WebSocket(`${BINANCE_STREAM_URL}?streams=${streams}`);
        socketRef.current = ws;

        // WS health logging
        ws.onopen = () => {
            console.log(`[WS] Connected: ${activeSymbols.join(', ')}`);
        };
        ws.onerror = (err) => {
            console.warn(`[WS] Error:`, err);
        };
        ws.onclose = (ev) => {
            console.warn(`[WS] Closed: code=${ev.code}, reason=${ev.reason || 'none'}`);
        };

        // Throttle for depth event received log (once per symbol)
        const depthReceivedLog = new Set<string>();

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            const symbol = msg.data.s;
            if (!symbol || !trackers.current.has(symbol)) return;

            const tracker = trackers.current.get(symbol)!;
            const stream = msg.stream;
            const payload = msg.data;

            // P1: Update server time from event timestamp (E field)
            if (payload.E) {
                tracker.lastServerTime = payload.E;
            }

            if (stream.includes('depth')) {
                // Log once per symbol that depth events are being received
                if (!depthReceivedLog.has(symbol)) {
                    depthReceivedLog.add(symbol);
                    console.log(`[WS] Depth event received: ${symbol}`);
                }
                tracker.engine.processEvent(payload as DepthEvent);
            }
            else if (stream.includes('aggTrade')) {
                const t = payload as AggTradeEvent;
                const price = parseFloat(t.p);
                const qty = parseFloat(t.q);
                const isBuy = !t.m;

                tracker.lastPrice = price;
                tracker.priceHistory.push(price);
                if (tracker.priceHistory.length > 100) tracker.priceHistory.shift();

                tracker.tradeQueue.push({
                    time: t.E,
                    size: qty,
                    side: isBuy ? 'buy' : 'sell',
                    price: price
                });

                const deltaVal = isBuy ? qty : -qty;
                tracker.cvd += deltaVal;
                tracker.totalVolume += qty;
                tracker.totalNotional += (price * qty);
                tracker.vwap = tracker.totalVolume > 0 ? tracker.totalNotional / tracker.totalVolume : 0;
            }
            else if (stream.includes('miniTicker')) {
                const mt = payload as MiniTickerEvent;
                tracker.high = parseFloat(mt.h);
                tracker.low = parseFloat(mt.l);
                tracker.tickerClose = parseFloat(mt.c);
                if (tracker.lastPrice === 0) tracker.lastPrice = tracker.tickerClose;
            }
        };

        // UI Update Loop (10 FPS)
        const interval = setInterval(() => {
            const localNow = Date.now();
            const nextState: AppState = {};

            // -------- Snapshot scheduler (runs on every tick) --------
            // Enqueue symbols that require snapshots if not already queued
            activeSymbols.forEach(sym => {
                const t = trackers.current.get(sym);
                if (!t) return;
                const engine = t.engine;
                // If engine signals it needs resync and is not currently doing a snapshot
                if (engine.getNeedsResync() && !engine.getResyncInFlight()) {
                    const now = localNow;
                    // Respect backoff: only enqueue if enough time has passed since last attempt
                    const timeSinceLast = now - engine.getLastResyncAt();
                    if (timeSinceLast >= engine.getBackoffMs()) {
                        // Avoid duplicate entries
                        if (!snapshotQueueRef.current.includes(sym)) {
                            snapshotQueueRef.current.push(sym);
                        }
                    }
                }
            });

            // If no snapshot is currently in progress, process next symbol in queue
            if (!snapshotInProgressRef.current && snapshotQueueRef.current.length > 0) {
                const nextSym = snapshotQueueRef.current.shift()!;
                const t = trackers.current.get(nextSym);
                if (t) {
                    snapshotInProgressRef.current = true;
                    // Initiate snapshot; on completion reset the flag
                    // We deliberately do not await here to avoid blocking UI updates;
                    // the engine manages its own resyncInFlight flag and needsResync state.
                    t.engine.initSnapshot().finally(() => {
                        snapshotInProgressRef.current = false;
                    });
                }
            }

            activeSymbols.forEach(sym => {
                const t = trackers.current.get(sym);
                if (!t) return;

                const engine = t.engine;
                const now = t.lastServerTime || localNow;

                // --- 1. Orderbook Metrics (From Engine) ---
                const { bids, asks } = engine.getBook(20);
                const obi = calculateOBI(bids, asks);
                const deepObi = calculateDeepOBI(bids, asks);

                // --- 2. Delta Metrics (Time Based) ---
                const cutoff = now - 60000;
                while (t.tradeQueue.length > 0 && t.tradeQueue[0].time < cutoff) {
                    t.tradeQueue.shift();
                }

                const d1s = calculateRollingDelta(t.tradeQueue, 1000, now);
                const d5s = calculateRollingDelta(t.tradeQueue, 5000, now);

                t.delta1sHistory.push(d1s);
                if (t.delta1sHistory.length > 60) t.delta1sHistory.shift();

                t.cvdHistory.push(t.cvd);
                if (t.cvdHistory.length > 20) t.cvdHistory.shift();

                // --- 3. Advanced Math ---
                const zScore = calculateZScore(t.delta1sHistory);
                const slope = calculateLinearRegressionSlope(t.cvdHistory);

                const refIdx = Math.max(0, t.priceHistory.length - 6);
                const refPrice = t.priceHistory[refIdx] || t.lastPrice;
                const priceChangePct = t.lastPrice > 0 ? (t.lastPrice - refPrice) / t.lastPrice : 0;
                const absorption = calculateAbsorption(d5s, priceChangePct);

                const regime = calculateRegime(t.priceHistory);
                const sweep = calculateSweepFade(t.lastPrice, t.priceHistory, d5s);
                const breakout = calculateBreakout(t.lastPrice, t.high, t.low, slope);

                // --- P0: Price Stability Fallback ---
                let priceSource: PriceSource = 'trade';
                const bestBid = bids[0]?.price || 0;
                const bestAsk = asks[0]?.price || 0;

                if (t.lastPrice <= 0) {
                    if (bestBid > 0 && bestAsk > 0 && bestBid < bestAsk) {
                        t.lastPrice = (bestBid + bestAsk) / 2;
                        priceSource = 'mid';
                    } else if (t.lastGoodObiWeighted !== 0 && t.lastGoodBids.length > 0) {
                        // Use mid from lastGood book
                        const lgBid = t.lastGoodBids[0]?.price || 0;
                        const lgAsk = t.lastGoodAsks[0]?.price || 0;
                        if (lgBid > 0 && lgAsk > 0) {
                            t.lastPrice = (lgBid + lgAsk) / 2;
                            priceSource = 'lastGood';
                        }
                    } else if (t.tickerClose > 0) {
                        t.lastPrice = t.tickerClose;
                        priceSource = 'ticker';
                    } else {
                        priceSource = 'none';
                    }
                }

                // --- Book Validity Gate ---
                const bookIsValid =
                    engine.getIsSynced() &&
                    !engine.getResyncInFlight() &&
                    bids.length > 0 &&
                    asks.length > 0 &&
                    bestBid > 0 &&
                    bestAsk > 0 &&
                    bestBid < bestAsk;

                // --- P1: Cache Split ---
                // Update lastGood cache for book-based data only
                let finalBids: OrderBookLevel[];
                let finalAsks: OrderBookLevel[];
                let finalObiWeighted: number;
                let finalObiSpoof: number;

                if (bookIsValid) {
                    // Update cache
                    t.lastGoodBids = bids;
                    t.lastGoodAsks = asks;
                    t.lastGoodObiWeighted = obi;
                    t.lastGoodObiSpoof = deepObi;
                    t.lastGoodAt = localNow;

                    finalBids = bids;
                    finalAsks = asks;
                    finalObiWeighted = obi;
                    finalObiSpoof = deepObi;
                } else {
                    // Use lastGood for book-based data if available
                    if (t.lastGoodBids.length > 0 && t.lastGoodAsks.length > 0) {
                        finalBids = t.lastGoodBids;
                        finalAsks = t.lastGoodAsks;
                        finalObiWeighted = t.lastGoodObiWeighted;
                        finalObiSpoof = t.lastGoodObiSpoof;
                    } else {
                        // No lastGood yet - use current (may be empty)
                        finalBids = bids;
                        finalAsks = asks;
                        finalObiWeighted = obi;
                        finalObiSpoof = deepObi;
                    }
                }

                // --- Construct metrics (trade-based always current, book-based from cache split) ---
                const finalMetrics: OrderFlowMetrics = {
                    symbol: sym,
                    price: t.lastPrice,
                    high24h: t.high,
                    low24h: t.low,
                    obiWeighted: finalObiWeighted,
                    obiSpoof: finalObiSpoof,
                    cvd: t.cvd,
                    delta1s: d1s,
                    delta5s: d5s,
                    deltaZ: zScore,
                    cvdSlope: slope,
                    vwap: t.vwap,
                    totalVolume: t.totalVolume,
                    totalNotional: t.totalNotional,
                    tradeCount: t.tradeQueue.length,
                    absorptionScore: absorption,
                    sweepFadeScore: sweep,
                    breakoutScore: breakout,
                    regimeWeight: regime
                };

                nextState[sym] = {
                    metrics: finalMetrics,
                    bids: finalBids,
                    asks: finalAsks,
                    recentTrades: t.tradeQueue.slice(-20).reverse()
                };

                // --- Per-symbol throttled debug logging ---
                const lastLog = debugThrottleMap.get(sym) || 0;
                const shouldLog = DEBUG_ALL_SYMBOLS || DEBUG_SYMBOLS.includes(sym);

                if (shouldLog && localNow - lastLog > 2000) {
                    debugThrottleMap.set(sym, localNow);
                    const lastGoodAgeMs = t.lastGoodAt > 0 ? localNow - t.lastGoodAt : -1;
                    console.log(`[DEBUG ${sym}]`, {
                        engineId: engine.getInstanceId(),
                        isSynced: engine.getIsSynced(),
                        resyncInFlight: engine.getResyncInFlight(),
                        bufferLen: engine.getBufferLength(),
                        backoffMs: engine.getBackoffMs(),
                        bestBid,
                        bestAsk,
                        bookLevels: { bids: bids.length, asks: asks.length },
                        bookIsValid,
                        obiWeighted: finalObiWeighted.toFixed(4),
                        obiSpoof: finalObiSpoof.toFixed(4),
                        delta1s: d1s.toFixed(4),
                        delta5s: d5s.toFixed(4),
                        lastGoodAgeMs,
                        priceSource
                    });
                }

                // --- Invariant violation warning (all symbols, throttled) ---
                if (engine.getIsSynced() && !engine.getResyncInFlight() && engine.getBufferLength() > 0) {
                    const lastWarn = debugThrottleMap.get(`${sym}_warn`) || 0;
                    if (localNow - lastWarn > 2000) {
                        debugThrottleMap.set(`${sym}_warn`, localNow);
                        console.warn(`[WARN ${sym}] invariant violated: bufferLen > 0 in steady state`, {
                            engineId: engine.getInstanceId(),
                            bufferLen: engine.getBufferLength()
                        });
                    }
                }

                // --- Safety assert: synced but empty book (throttled) ---
                if (engine.getIsSynced() && (bids.length === 0 || asks.length === 0)) {
                    const lastWarn = debugThrottleMap.get(`${sym}_empty`) || 0;
                    if (localNow - lastWarn > 2000) {
                        debugThrottleMap.set(`${sym}_empty`, localNow);
                        console.warn(`[WARN ${sym}] Synced=true but orderbook empty`);
                    }
                }
            });

            setData(nextState);

        }, 100);

        return () => {
            clearInterval(interval);
            if (socketRef.current) socketRef.current.close();
            trackers.current.clear();
        };
    }, [activeSymbols]);

    return data;
};