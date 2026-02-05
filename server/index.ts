/**
 * Binance Proxy Server
 * 
 * Handles REST depth snapshots and WebSocket stream forwarding
 * with rate limiting, backoff, caching, and CORS support.
 */

import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import cors from 'cors';

// ============================================================================
// Configuration
// ============================================================================

const PORT = parseInt(process.env.PORT || '8787', 10);
const BINANCE_REST_BASE = 'https://fapi.binance.com';
const BINANCE_WS_BASE = 'wss://fstream.binance.com/stream';

// CORS origins
const ALLOWED_ORIGINS = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'http://127.0.0.1:5175',
    // Add VPS domain/IP here in production
];

// ============================================================================
// State
// ============================================================================

interface DepthCache {
    lastUpdateId: number;
    bids: [string, string][];
    asks: [string, string][];
    cachedAt: number;
}

interface RateLimitState {
    lastRequest: number;
    backoffMs: number;
}

// In-memory caches
const depthCache = new Map<string, DepthCache>();
const rateLimitState = new Map<string, RateLimitState>();

// Constants
const MIN_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;
const RATE_LIMIT_INTERVAL_MS = 500; // Per-symbol request throttle
const CACHE_TTL_MS = 5000; // Cache validity duration

// WebSocket state
let binanceWs: WebSocket | null = null;
let binanceWsState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

// Track connected clients and their subscribed symbols
const wsClients = new Set<WebSocket>();
const clientSymbols = new Map<WebSocket, Set<string>>();
let currentStreamSymbols = new Set<string>();

// Server uptime
const startTime = Date.now();

// ============================================================================
// Logging
// ============================================================================

function log(level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: any) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${message}`;
    if (data) {
        console.log(line, data);
    } else {
        console.log(line);
    }
}

// ============================================================================
// Binance REST API - Depth Snapshot
// ============================================================================

async function fetchBinanceDepth(symbol: string, limit: number = 1000): Promise<DepthCache | null> {
    const url = `${BINANCE_REST_BASE}/fapi/v1/depth?symbol=${symbol}&limit=${limit}`;

    try {
        const response = await fetch(url);

        if (!response.ok) {
            const status = response.status;

            if (status === 429 || status === 418) {
                // Rate limited - increase backoff
                const state = rateLimitState.get(symbol) || { lastRequest: 0, backoffMs: MIN_BACKOFF_MS };
                state.backoffMs = Math.min(state.backoffMs * 2, MAX_BACKOFF_MS);
                rateLimitState.set(symbol, state);
                log('WARN', `Rate limited (${status}) for ${symbol}, backoff: ${state.backoffMs}ms`);
                return null;
            }

            log('ERROR', `Binance depth fetch failed: ${status} for ${symbol}`);
            return null;
        }

        const data = await response.json();

        if (!data || !data.lastUpdateId || !Array.isArray(data.bids) || !Array.isArray(data.asks)) {
            log('ERROR', `Invalid depth data structure for ${symbol}`);
            return null;
        }

        // Reset backoff on success
        const state = rateLimitState.get(symbol) || { lastRequest: 0, backoffMs: MIN_BACKOFF_MS };
        state.backoffMs = MIN_BACKOFF_MS;
        state.lastRequest = Date.now();
        rateLimitState.set(symbol, state);

        // Update cache
        const cached: DepthCache = {
            lastUpdateId: data.lastUpdateId,
            bids: data.bids,
            asks: data.asks,
            cachedAt: Date.now()
        };
        depthCache.set(symbol, cached);

        return cached;

    } catch (error) {
        log('ERROR', `Network error fetching depth for ${symbol}`, error);
        return null;
    }
}

// ============================================================================
// Express App
// ============================================================================

const app = express();

// CORS middleware
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);

        if (ALLOWED_ORIGINS.includes(origin) || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
            return callback(null, true);
        }

        // Allow any origin in development (can be restricted in production)
        return callback(null, true);
    },
    credentials: true
}));

app.use(express.json());

// Health endpoint
app.get('/health', (_req: Request, res: Response) => {
    res.json({
        ok: true,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        wsClients: wsClients.size,
        binanceWsState,
        cacheSize: depthCache.size,
        activeSymbols: Array.from(currentStreamSymbols)
    });
});

// Depth snapshot endpoint
app.get('/api/depth/:symbol', async (req: Request, res: Response) => {
    const symbol = req.params.symbol.toUpperCase();
    const limit = Math.min(parseInt(req.query.limit as string) || 1000, 1000);

    // Rate limit check per symbol
    const state = rateLimitState.get(symbol) || { lastRequest: 0, backoffMs: MIN_BACKOFF_MS };
    const now = Date.now();
    const timeSinceLastRequest = now - state.lastRequest;

    // Check if we have a valid cache
    const cached = depthCache.get(symbol);
    const cacheAge = cached ? now - cached.cachedAt : Infinity;

    // If rate limited or request too soon, return cache if available
    if (timeSinceLastRequest < RATE_LIMIT_INTERVAL_MS || timeSinceLastRequest < state.backoffMs) {
        if (cached && cacheAge < CACHE_TTL_MS * 2) {
            log('INFO', `Serving cached depth for ${symbol} (throttled, age: ${cacheAge}ms)`);
            return res.json({
                lastUpdateId: cached.lastUpdateId,
                bids: cached.bids.slice(0, limit),
                asks: cached.asks.slice(0, limit),
                cachedAt: cached.cachedAt,
                source: 'cache'
            });
        }
    }

    // Try to fetch fresh data
    const freshData = await fetchBinanceDepth(symbol, limit);

    if (freshData) {
        return res.json({
            lastUpdateId: freshData.lastUpdateId,
            bids: freshData.bids.slice(0, limit),
            asks: freshData.asks.slice(0, limit),
            cachedAt: freshData.cachedAt,
            source: 'binance'
        });
    }

    // Fallback to cache
    if (cached) {
        log('WARN', `Serving stale cache for ${symbol} (fetch failed, age: ${cacheAge}ms)`);
        return res.json({
            lastUpdateId: cached.lastUpdateId,
            bids: cached.bids.slice(0, limit),
            asks: cached.asks.slice(0, limit),
            cachedAt: cached.cachedAt,
            source: 'cache'
        });
    }

    // No data available
    return res.status(503).json({
        error: 'Depth data unavailable',
        symbol,
        retryAfter: state.backoffMs
    });
});

// ============================================================================
// WebSocket Proxy
// ============================================================================

function buildStreamUrl(symbols: Set<string>): string {
    if (symbols.size === 0) return '';

    const streams = Array.from(symbols).flatMap(s => {
        const lower = s.toLowerCase();
        return [`${lower}@depth@100ms`, `${lower}@aggTrade`, `${lower}@miniTicker`];
    });

    return `${BINANCE_WS_BASE}?streams=${streams.join('/')}`;
}

function connectToBinance() {
    const allSymbols = new Set<string>();
    clientSymbols.forEach(symbols => {
        symbols.forEach(s => allSymbols.add(s));
    });

    if (allSymbols.size === 0) {
        log('INFO', 'No symbols to subscribe, closing Binance WS');
        if (binanceWs) {
            binanceWs.close();
            binanceWs = null;
        }
        binanceWsState = 'disconnected';
        currentStreamSymbols.clear();
        return;
    }

    // Check if symbols changed
    const symbolsChanged = allSymbols.size !== currentStreamSymbols.size ||
        Array.from(allSymbols).some(s => !currentStreamSymbols.has(s));

    if (!symbolsChanged && binanceWs && binanceWs.readyState === WebSocket.OPEN) {
        return; // No change needed
    }

    // Close existing connection
    if (binanceWs) {
        binanceWs.close();
        binanceWs = null;
    }

    currentStreamSymbols = allSymbols;
    binanceWsState = 'connecting';

    const url = buildStreamUrl(allSymbols);
    log('INFO', `Connecting to Binance: ${allSymbols.size} symbols`);

    binanceWs = new WebSocket(url);

    binanceWs.on('open', () => {
        binanceWsState = 'connected';
        reconnectAttempts = 0;
        log('INFO', `Binance WS connected: ${Array.from(allSymbols).join(', ')}`);
    });

    binanceWs.on('message', (data: Buffer) => {
        const msgStr = data.toString();

        // Forward to all connected clients
        wsClients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    // Parse to check symbol
                    const msg = JSON.parse(msgStr);
                    const symbol = msg?.data?.s;

                    // Only forward if client subscribed to this symbol
                    const clientSubs = clientSymbols.get(client);
                    if (clientSubs && symbol && clientSubs.has(symbol)) {
                        client.send(msgStr);
                    }
                } catch {
                    // Forward anyway if parse fails
                    client.send(msgStr);
                }
            }
        });
    });

    binanceWs.on('error', (error) => {
        log('ERROR', 'Binance WS error', error);
    });

    binanceWs.on('close', (code, reason) => {
        binanceWsState = 'disconnected';
        log('WARN', `Binance WS closed: code=${code}, reason=${reason.toString() || 'none'}`);

        // Reconnect with jitter if clients still connected
        if (wsClients.size > 0) {
            reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
            const jitter = Math.random() * 1000;
            log('INFO', `Reconnecting in ${delay + jitter}ms (attempt ${reconnectAttempts})`);
            setTimeout(connectToBinance, delay + jitter);
        }
    });
}

// ============================================================================
// HTTP Server + WebSocket Server
// ============================================================================

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws: WebSocket, req) => {
    // Parse symbols from query string
    const url = new URL(req.url || '', `http://localhost:${PORT}`);
    const symbolsParam = url.searchParams.get('symbols') || '';
    const symbols = new Set(
        symbolsParam.split(',')
            .map(s => s.trim().toUpperCase())
            .filter(s => s.length > 0)
    );

    log('INFO', `Client connected, symbols: ${Array.from(symbols).join(', ') || 'none'}`);

    wsClients.add(ws);
    clientSymbols.set(ws, symbols);

    // Trigger Binance connection update
    connectToBinance();

    ws.on('message', (data: Buffer) => {
        // Handle client messages (e.g., subscribe/unsubscribe)
        try {
            const msg = JSON.parse(data.toString());

            if (msg.type === 'subscribe' && Array.isArray(msg.symbols)) {
                const clientSubs = clientSymbols.get(ws) || new Set();
                msg.symbols.forEach((s: string) => clientSubs.add(s.toUpperCase()));
                clientSymbols.set(ws, clientSubs);
                connectToBinance();
                log('INFO', `Client subscribed to: ${msg.symbols.join(', ')}`);
            }

            if (msg.type === 'unsubscribe' && Array.isArray(msg.symbols)) {
                const clientSubs = clientSymbols.get(ws);
                if (clientSubs) {
                    msg.symbols.forEach((s: string) => clientSubs.delete(s.toUpperCase()));
                    connectToBinance();
                    log('INFO', `Client unsubscribed from: ${msg.symbols.join(', ')}`);
                }
            }
        } catch {
            // Ignore invalid messages
        }
    });

    ws.on('close', () => {
        log('INFO', 'Client disconnected');
        wsClients.delete(ws);
        clientSymbols.delete(ws);
        connectToBinance();
    });

    ws.on('error', (error) => {
        log('ERROR', 'Client WS error', error);
    });

    // Send initial connection confirmation
    ws.send(JSON.stringify({
        type: 'connected',
        symbols: Array.from(symbols),
        timestamp: Date.now()
    }));
});

// ============================================================================
// Start Server
// ============================================================================

server.listen(PORT, () => {
    log('INFO', `Binance Proxy Server running on port ${PORT}`);
    log('INFO', `Health endpoint: http://localhost:${PORT}/health`);
    log('INFO', `Depth endpoint: http://localhost:${PORT}/api/depth/:symbol`);
    log('INFO', `WebSocket endpoint: ws://localhost:${PORT}/ws?symbols=BTCUSDT,ETHUSDT`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    log('INFO', 'Shutting down...');
    if (binanceWs) binanceWs.close();
    wsClients.forEach(client => client.close());
    server.close(() => {
        log('INFO', 'Server closed');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    log('INFO', 'SIGTERM received, shutting down...');
    if (binanceWs) binanceWs.close();
    wsClients.forEach(client => client.close());
    server.close(() => process.exit(0));
});
