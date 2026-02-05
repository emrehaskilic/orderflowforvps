// Binance WebSocket Types

export interface WsEvent {
    e: string; // Event type
    E: number; // Event time
    s: string; // Symbol
}
  
export interface AggTradeEvent extends WsEvent {
    p: string; // Price
    q: string; // Quantity
    m: boolean; // Is the buyer the market maker? (true = Sell, false = Buy)
}
  
export interface DepthEvent extends WsEvent {
    U: number; // First update ID
    u: number; // Final update ID
    pu: number; // Final update ID in last stream(ie ‘u’ in last stream)
    b: [string, string][]; // Bids [Price, Quantity]
    a: [string, string][]; // Asks [Price, Quantity]
}
  
export interface MiniTickerEvent extends WsEvent {
    c: string; // Close price
    h: string; // High price
    l: string; // Low price
    v: string; // Total traded base asset volume
}

// Internal Data Structures
export interface TradeItem {
    price: number;
    size: number;
    side: 'buy' | 'sell';
    time: number;
}
  
export interface OrderBookLevel {
    price: number;
    size: number;
    total: number; // Cumulative for visualization
}
  
export interface OrderFlowMetrics {
    symbol: string;
    price: number;
    high24h: number;
    low24h: number;
    
    // Order Book Metrics
    obiWeighted: number;
    obiSpoof: number; // Deep Book OBI
    
    // Volume & Delta
    cvd: number; // Session CVD
    delta1s: number; // True Rolling 1s
    delta5s: number; // True Rolling 5s
    deltaZ: number; // Statistical Z-Score (Mean/StdDev)
    cvdSlope: number; // Linear Regression Slope
    
    // Advanced Orderflow
    vwap: number; // Session VWAP
    totalVolume: number;
    totalNotional: number;
    
    // Advanced Scores (Heuristic but based on strict data)
    absorptionScore: number;
    sweepFadeScore: number; 
    breakoutScore: number; 
    regimeWeight: number;

    tradeCount: number;
}
  
export interface AppState {
    [symbol: string]: {
        metrics: OrderFlowMetrics;
        bids: OrderBookLevel[];
        asks: OrderBookLevel[];
        // We only expose the last few trades for the UI list
        recentTrades: TradeItem[];
    }
}