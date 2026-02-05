import { OrderBookLevel, TradeItem } from '../types';

export const formatCurrency = (val: number, decimals = 2) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(val).replace('$', '');
};

export const formatNumber = (val: number, decimals = 2) => {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(val);
};

/**
 * Calculates Weighted Order Book Imbalance.
 * Uses a linear decay weight so top-of-book matters more.
 */
export const calculateOBI = (bids: OrderBookLevel[], asks: OrderBookLevel[], depth = 10): number => {
  if (bids.length === 0 || asks.length === 0) return 0;

  let bidVol = 0;
  let askVol = 0;

  const maxDepth = Math.min(depth, bids.length, asks.length);

  for (let i = 0; i < maxDepth; i++) {
    const weight = 1 - (i / maxDepth);
    bidVol += bids[i].size * weight;
    askVol += asks[i].size * weight;
  }

  const total = bidVol + askVol;
  if (total === 0) return 0;

  return (bidVol - askVol) / total;
};

/**
 * Calculates Deep Book OBI (Spoof Resistant).
 * Ignores the first 2 levels (touch) to see liquidity backing.
 */
export const calculateDeepOBI = (bids: OrderBookLevel[], asks: OrderBookLevel[], depth = 10): number => {
  if (bids.length < 3 || asks.length < 3) return 0;

  let bidVol = 0;
  let askVol = 0;

  const maxDepth = Math.min(depth, bids.length, asks.length);

  // Start from index 2
  for (let i = 2; i < maxDepth; i++) {
    bidVol += bids[i].size;
    askVol += asks[i].size;
  }

  const total = bidVol + askVol;
  if (total === 0) return 0;

  return (bidVol - askVol) / total;
};

/**
 * Calculates Delta from a specific time window.
 * P1: Uses provided nowMs (server time) instead of Date.now() for clock skew fix.
 */
export const calculateRollingDelta = (trades: TradeItem[], windowMs: number, nowMs: number): number => {
  const cutoff = nowMs - windowMs;
  let delta = 0;

  // Iterate through trades - they are sorted by time from WS.
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].time > cutoff) {
      delta += (trades[i].side === 'buy' ? trades[i].size : -trades[i].size);
    }
  }
  return delta;
};

/**
 * Calculates Standard Deviation based Z-Score.
 */
export const calculateZScore = (values: number[]): number => {
  if (values.length < 2) return 0;

  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return 0;

  const lastValue = values[values.length - 1];
  return (lastValue - mean) / stdDev;
};

/**
 * Calculates Slope using Linear Regression (Least Squares).
 * Returns the slope (m) of y = mx + c
 */
export const calculateLinearRegressionSlope = (values: number[]): number => {
  const n = values.length;
  if (n < 2) return 0;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  return slope;
};

// --- ADVANCED METRICS (Strictly Data Driven) ---

export const calculateAbsorption = (delta5s: number, priceChangePct: number): number => {
  const volumeIntensity = Math.abs(delta5s);
  const movementBps = Math.abs(priceChangePct) * 10000; // price change in basis points

  // Adaptive thresholds: consider smaller volume threshold and wider movement window
  // to detect absorption across different symbols. Use a scaled ratio for score.
  // If volume intensity is very low, treat as no absorption.
  if (volumeIntensity < 50) {
    return 0;
  }

  // Compute a basic ratio: high volume / (small movement + 1) results in higher score.
  // The constant 5 controls sensitivity to movement; increase if too sensitive.
  const ratio = volumeIntensity / (movementBps + 5);

  // Map ratio to 0-100 range with a logarithmic scale to prevent extremely high scores.
  const score = Math.min(100, Math.log10(1 + ratio) * 40);

  return score;
};

export const calculateRegime = (priceHistory: number[]): number => {
  if (priceHistory.length < 20) return 0;
  // Standard deviation of returns (volatility)
  const returns = [];
  for (let i = 1; i < priceHistory.length; i++) {
    returns.push((priceHistory[i] - priceHistory[i - 1]) / priceHistory[i - 1]);
  }
  const z = calculateZScore(returns);
  // High Z-score variance usually implies trend/breakout regime
  return Math.min(100, Math.abs(z) * 20);
};

export const calculateSweepFade = (currentPrice: number, priceHistory: number[], delta5s: number): number => {
  if (priceHistory.length < 5) return 0;

  const recent = priceHistory.slice(-20);
  const max = Math.max(...recent);
  const min = Math.min(...recent);

  // Is price pushing boundaries?
  const isHigh = currentPrice >= max;
  const isLow = currentPrice <= min;

  if (!isHigh && !isLow) return 0;

  // Intensity of the move (Delta)
  const intensity = Math.min(100, Math.abs(delta5s));

  return intensity;
};

export const calculateBreakout = (currentPrice: number, high: number, low: number, slope: number): number => {
  // Proximity to 24h High/Low
  const distHigh = Math.abs((high - currentPrice) / currentPrice);
  const distLow = Math.abs((low - currentPrice) / currentPrice);

  // Check if very close (e.g., 0.1%)
  const threshold = 0.001;
  let score = 0;

  if (distHigh < threshold && slope > 0) {
    // Breaking high with positive momentum
    score = 50 + (slope * 50);
  } else if (distLow < threshold && slope < 0) {
    // Breaking low with negative momentum
    score = 50 + (Math.abs(slope) * 50);
  }

  return Math.min(100, Math.max(0, score));
};