import { OrderBookLevel } from "../types";

// Helper to sort and convert Map<string, number> to Array
const sortBook = (book: Map<string, number>, isAsk: boolean, limit: number): OrderBookLevel[] => {
    const sortedKeys = Array.from(book.keys()).sort((a, b) => {
        const priceA = parseFloat(a);
        const priceB = parseFloat(b);
        return isAsk ? priceA - priceB : priceB - priceA;
    });
    const result: OrderBookLevel[] = [];
    let cumulative = 0;

    for (const key of sortedKeys) {
        if (result.length >= limit) break;
        const size = book.get(key) || 0;
        if (size > 0) {
            cumulative += size;
            result.push({ price: parseFloat(key), size, total: cumulative });
        }
    }
    return result;
};

// Debug throttle state (module level, per-symbol)
const debugThrottleMap = new Map<string, number>();

// Buffer size limit (memory safety)
const MAX_BUFFER_SIZE = 2000;

export class OrderBookEngine {
    symbol: string;
    bids: Map<string, number>;
    asks: Map<string, number>;
    lastUpdateId: number;
    isSynced: boolean;
    buffer: any[];

    // Resync state
    private resyncInFlight: boolean;
    private lastResyncAt: number;
    /**
     * Indicates whether a new snapshot is required. This flag is set when the
     * engine has not yet received an initial snapshot or when a gap is
     * detected in the depth stream. The useBinanceSocket scheduler should
     * monitor this flag and call initSnapshot() when appropriate. It is
     * cleared when a snapshot completes successfully.
     */
    private needsResync: boolean;

    /**
     * When true the engine is running in degraded mode. This mode is entered
     * if a snapshot cannot be obtained but depth updates are still flowing.
     * In degraded mode the first depth update is used to seed the local
     * orderbook so that the UI does not appear empty. Once a snapshot is
     * successfully applied the engine exits degraded mode.
     */
    private degraded: boolean;

    // P1: Snapshot backoff for 429/418
    private snapshotBackoffMs: number;
    private readonly maxBackoffMs: number = 30000;
    private readonly minBackoffMs: number = 2000;
    private retryTimeoutId: ReturnType<typeof setTimeout> | null = null;

    // A1: Unique instance id for diagnostics
    private instanceId: string;

    constructor(symbol: string) {
        this.symbol = symbol;
        this.bids = new Map();
        this.asks = new Map();
        this.lastUpdateId = 0;
        this.isSynced = false;
        this.buffer = [];
        this.resyncInFlight = false;
        this.lastResyncAt = 0;
        this.snapshotBackoffMs = this.minBackoffMs;
        // A1: Generate unique instance id
        this.instanceId = `${symbol}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        // Start with resync needed until the first snapshot completes successfully
        this.needsResync = true;
        this.degraded = false;
    }

    /**
     * Returns true if the engine currently requires a new snapshot. This
     * flag is set whenever the initial snapshot has not yet completed or
     * when a gap is detected in the depth stream. It is cleared after a
     * successful snapshot.  useBinanceSocket should monitor this flag and
     * call initSnapshot() when appropriate.  Exposed publicly to allow
     * scheduling snapshots without concurrent calls across symbols.
     */
    public getNeedsResync(): boolean {
        return this.needsResync;
    }

    /**
     * Returns the timestamp of the last snapshot attempt. Exposed to
     * allow external schedulers to respect backoff intervals.
     */
    public getLastResyncAt(): number {
        return this.lastResyncAt;
    }

    /**
     * Indicates whether the engine is currently running in degraded mode.
     * Degraded mode is entered when a snapshot cannot be obtained but
     * depth updates are still flowing; the first depth update is used to
     * seed the orderbook. Once a snapshot is successfully applied the
     * engine exits degraded mode.
     */
    public getDegraded(): boolean {
        return this.degraded;
    }

    public async initSnapshot() {
        // Prevent concurrent snapshot attempts; if a snapshot is already in progress, do nothing.
        if (this.resyncInFlight) return;

        // A2: Set resyncInFlight at start and record the attempt time
        this.resyncInFlight = true;
        this.lastResyncAt = Date.now();

        try {
            // Use a smaller snapshot depth to reduce rate limit pressure. 200 levels is
            // sufficient for OBI calculations and reduces 418/429 errors when
            // snapshots are requested concurrently across multiple symbols.
            const response = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${this.symbol}&limit=200`);

            // A) Check response.ok BEFORE any state mutation
            if (!response.ok) {
                const status = response.status;
                if (status === 429 || status === 418) {
                    // Rate limited - apply exponential backoff
                    this.snapshotBackoffMs = Math.min(this.snapshotBackoffMs * 2, this.maxBackoffMs);
                    console.warn(`[${this.symbol}] Snapshot rate limited (${status}), backoff: ${this.snapshotBackoffMs}ms`);
                    // Schedule retry - do NOT clear book, do NOT change isSynced
                    this.scheduleRetry();
                } else {
                    console.error(`[${this.symbol}] Snapshot fetch failed: ${status}`);
                    // For other errors, also retry with backoff
                    this.snapshotBackoffMs = Math.min(this.snapshotBackoffMs * 2, this.maxBackoffMs);
                    this.scheduleRetry();
                }
                // DO NOT clear bids/asks - keep existing book
                // DO NOT reset isSynced - keep current state
                // Do not proceed with snapshot; keep needsResync = true so that
                // scheduler will retry later.
                return;
            }

            // Parse JSON - also might fail
            let data;
            try {
                data = await response.json();
            } catch (jsonError) {
                console.error(`[${this.symbol}] Snapshot JSON parse failed`, jsonError);
                this.snapshotBackoffMs = Math.min(this.snapshotBackoffMs * 2, this.maxBackoffMs);
                this.scheduleRetry();
                return;
            }

            // Validate data structure
            if (!data || !data.lastUpdateId || !Array.isArray(data.bids) || !Array.isArray(data.asks)) {
                console.error(`[${this.symbol}] Snapshot invalid data structure`);
                this.snapshotBackoffMs = Math.min(this.snapshotBackoffMs * 2, this.maxBackoffMs);
                this.scheduleRetry();
                return;
            }

            // SUCCESS: Now safe to update book
            this.lastUpdateId = data.lastUpdateId;
            this.bids.clear();
            this.asks.clear();

            // P0: Use string key (b[0]), parseFloat for value
            data.bids.forEach((b: string[]) => this.bids.set(b[0], parseFloat(b[1])));
            data.asks.forEach((a: string[]) => this.asks.set(a[0], parseFloat(a[1])));

            // Replay buffer with Binance standard sync logic
            const replaySuccess = this.replayBuffer();

            if (replaySuccess) {
                // On success mark the book as synced and clear resync requirement
                this.isSynced = true;
                this.needsResync = false;
                // Reset backoff on success
                this.snapshotBackoffMs = this.minBackoffMs;
                // Exit degraded mode on successful snapshot
                this.degraded = false;
            } else {
                // Buffer doesn't contain valid continuation - keep resync needed
                this.isSynced = false;
                this.needsResync = true;
                this.scheduleRetry();
            }
        } catch (e) {
            console.error(`[${this.symbol}] Snapshot network error`, e);
            // Network error - apply backoff, DO NOT clear book
            this.snapshotBackoffMs = Math.min(this.snapshotBackoffMs * 2, this.maxBackoffMs);
            // Keep needsResync = true so scheduler will retry
            this.needsResync = true;
            this.scheduleRetry();
        } finally {
            // B) Single exit point for resyncInFlight; snapshot attempt finished
            this.resyncInFlight = false;
        }
    }

    /**
     * Schedule a retry with the current backoff delay.
     * Only schedules if not already scheduled.
     */
    private scheduleRetry() {
        if (this.retryTimeoutId !== null) return; // Already scheduled

        this.retryTimeoutId = setTimeout(() => {
            this.retryTimeoutId = null;
            if (!this.resyncInFlight) {
                this.initSnapshot();
            }
        }, this.snapshotBackoffMs);
    }

    /**
     * Replay buffer after snapshot with Binance standard sync logic.
     * Returns true if sync was successful, false if no valid continuation found.
     */
    private replayBuffer(): boolean {
        if (this.buffer.length === 0) {
            // No buffer to replay - snapshot is fresh enough
            return true;
        }

        // Sort buffer by u (final update ID) to ensure order
        this.buffer.sort((a, b) => a.u - b.u);

        // Find the first event that satisfies Binance sync condition:
        // event.U <= lastUpdateId + 1 && event.u >= lastUpdateId + 1
        let foundValidStart = false;
        let startIdx = -1;

        for (let i = 0; i < this.buffer.length; i++) {
            const event = this.buffer[i];

            // Skip events older than snapshot
            if (event.u <= this.lastUpdateId) continue;

            // Check Binance sync condition
            if (event.U <= this.lastUpdateId + 1 && event.u >= this.lastUpdateId + 1) {
                foundValidStart = true;
                startIdx = i;
                break;
            }
        }

        if (!foundValidStart) {
            // No valid continuation in buffer - clear and return false
            this.buffer = [];
            return false;
        }

        // Apply events from startIdx onwards
        for (let i = startIdx; i < this.buffer.length; i++) {
            const event = this.buffer[i];

            // Continuity check - detect gap during replay
            if (event.U > this.lastUpdateId + 1) {
                this.buffer = [];
                return false;
            }

            // Only apply if event continues from current state
            if (event.u > this.lastUpdateId) {
                this.applyUpdate(event.b, this.bids);
                this.applyUpdate(event.a, this.asks);
                this.lastUpdateId = event.u;
            }
        }

        // Clear buffer after successful replay
        this.buffer = [];
        return true;
    }

    public processEvent(event: any) {
        const now = Date.now();

        // Steady-state buffer invariant - clear leaked buffer
        if (this.isSynced && !this.resyncInFlight && this.buffer.length > 0) {
            this.buffer = [];
        }

        // If resync is in flight, buffer all events and return
        if (this.resyncInFlight) {
            this.addToBuffer(event, now);
            return;
        }

        // If not synced yet, buffer the event and mark resync needed. Do not
        // trigger snapshot here; the useBinanceSocket scheduler will handle
        // initiating snapshots when appropriate.
        if (!this.isSynced) {
            // If we haven't seeded the book yet but depth updates are flowing,
            // enter degraded mode. Use the first valid depth event to seed
            // the orderbook so the UI is not empty. After seeding the book we
            // apply further updates normally. Snapshot will still be attempted
            // via the scheduler.
            if (!this.degraded && typeof event?.u === 'number' && Array.isArray(event?.b) && Array.isArray(event?.a)) {
                // Seed lastUpdateId from this event and apply its updates
                this.lastUpdateId = event.u;
                this.applyUpdate(event.b, this.bids);
                this.applyUpdate(event.a, this.asks);
                this.degraded = true;
                this.isSynced = true;
                // Mark that we still need a proper snapshot
                this.needsResync = true;
                return;
            }
            // Not degraded yet or this event is not a depth update: buffer
            this.addToBuffer(event, now);
            // Always mark resync needed until snapshot completes successfully
            this.needsResync = true;
            return;
        }

        // Drop events older than our current state
        if (event.u <= this.lastUpdateId) return;

        // Gap detection: expected next event should have U <= lastUpdateId + 1
        const hasGap = event.U > this.lastUpdateId + 1;

        if (hasGap) {
            // Debug log for gap detection (throttled, per-symbol)
            const lastLog = debugThrottleMap.get(this.symbol) || 0;
            if (now - lastLog > 2000) {
                debugThrottleMap.set(this.symbol, now);
                console.log(`[${this.symbol}] Gap detected: expected U <= ${this.lastUpdateId + 1}, got U=${event.U}`);
            }

            // 1) Add event to buffer (don't lose it)
            this.addToBuffer(event, now);

            // 2) Mark resync needed; scheduler will initiate snapshot
            this.needsResync = true;

            // 3) Don't apply update on gap
            return;
        }

        // Normal flow: apply update
        this.applyUpdate(event.b, this.bids);
        this.applyUpdate(event.a, this.asks);
        this.lastUpdateId = event.u;
    }

    /**
     * Add event to buffer with size limit (memory safety).
     * Only buffer valid depth events (must have u and U fields).
     */
    private addToBuffer(event: any, now: number) {
        // Defensive check - only buffer depth events with valid update IDs
        if (typeof event?.u !== 'number' || typeof event?.U !== 'number') {
            return;
        }

        // Buffer size limit check
        if (this.buffer.length >= MAX_BUFFER_SIZE) {
            // Drop oldest events (FIFO)
            const dropCount = Math.floor(MAX_BUFFER_SIZE * 0.1);
            this.buffer.splice(0, dropCount);

            // Throttled debug log for buffer overflow (per-symbol)
            const lastLog = debugThrottleMap.get(this.symbol) || 0;
            if (now - lastLog > 2000) {
                debugThrottleMap.set(this.symbol, now);
                console.log(`[${this.symbol}] Buffer overflow: dropped ${dropCount} oldest events`);
            }
        }

        this.buffer.push(event);
    }

    // applyUpdate with string keys
    private applyUpdate(updates: [string, string][], book: Map<string, number>) {
        if (!updates) return;
        for (const [p, q] of updates) {
            const qty = parseFloat(q);
            if (qty === 0) {
                book.delete(p);
            } else {
                book.set(p, qty);
            }
        }
    }

    public getBook(depth: number) {
        return {
            bids: sortBook(this.bids, false, depth),
            asks: sortBook(this.asks, true, depth)
        };
    }

    // Expose for debug logging
    public getLastUpdateId(): number {
        return this.lastUpdateId;
    }

    public getBufferLength(): number {
        return this.buffer.length;
    }

    public getIsSynced(): boolean {
        return this.isSynced;
    }

    public getResyncInFlight(): boolean {
        return this.resyncInFlight;
    }

    public getInstanceId(): string {
        return this.instanceId;
    }

    public getBackoffMs(): number {
        return this.snapshotBackoffMs;
    }

    // Cleanup for unmount
    public destroy() {
        if (this.retryTimeoutId !== null) {
            clearTimeout(this.retryTimeoutId);
            this.retryTimeoutId = null;
        }
    }
}