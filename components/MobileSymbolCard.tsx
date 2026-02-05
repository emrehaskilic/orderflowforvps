import React, { useState } from 'react';
import { AppState } from '../types';
import { formatCurrency } from '../services/mathUtils';
import { OrderBook } from './OrderBook';
import { MetricValue, SlopeIcon, ScoreBar } from './Shared';

interface MobileSymbolCardProps {
    symbol: string;
    data: AppState[string];
}

export const MobileSymbolCard: React.FC<MobileSymbolCardProps> = ({ symbol, data }) => {
    const [expanded, setExpanded] = useState(false);
    const { metrics, bids, asks } = data;

    return (
        <div className="bg-zinc-900/50 border border-zinc-800 rounded-lg overflow-hidden shadow-sm">
            {/* Header Row */}
            <div
                className="p-4 cursor-pointer select-none active:bg-zinc-800/50 transition-colors"
                onClick={() => setExpanded(!expanded)}
            >
                <div className="flex justify-between items-center mb-3">
                    <div className="flex items-center space-x-2">
                        <span className="font-bold text-white text-lg">{symbol}</span>
                        <SlopeIcon value={metrics.cvdSlope} />
                    </div>
                    <div className="font-mono text-xl text-zinc-100 font-semibold tracking-tight">
                        {formatCurrency(metrics.price)}
                    </div>
                </div>

                {/* Primary Metrics Grid */}
                <div className="grid grid-cols-3 gap-2 bg-black/20 rounded p-2 border border-zinc-800/50">
                    <div className="flex flex-col items-center">
                        <span className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">OBI (W)</span>
                        <MetricValue value={metrics.obiWeighted} />
                    </div>
                    <div className="flex flex-col items-center border-l border-zinc-800/50">
                        <span className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Delta Z</span>
                        <MetricValue value={metrics.deltaZ} />
                    </div>
                    <div className="flex flex-col items-center border-l border-zinc-800/50">
                        <span className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Slope</span>
                        <MetricValue value={metrics.cvdSlope} />
                    </div>
                </div>
            </div>

            {/* Expanded Content */}
            {expanded && (
                <div className="border-t border-zinc-800 p-4 space-y-6 bg-black/20 animate-in slide-in-from-top-2 duration-200">

                    {/* Order Book */}
                    <div>
                        <div className="flex justify-between items-end mb-2">
                            <h4 className="text-zinc-400 text-xs font-semibold uppercase tracking-wider">Orderbook</h4>
                            <span className="text-[10px] text-zinc-600">Depth 10</span>
                        </div>
                        <OrderBook bids={bids} asks={asks} currentPrice={metrics.price} />
                    </div>

                    {/* Secondary Metrics */}
                    <div className="space-y-3">
                        <h4 className="text-zinc-400 text-xs font-semibold uppercase tracking-wider">Advanced Metrics</h4>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                            <div className="flex justify-between">
                                <span className="text-zinc-500">VWAP</span>
                                <span className="font-mono text-blue-300">{formatCurrency(metrics.vwap)}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-zinc-500">CVD</span>
                                <MetricValue value={metrics.cvd} />
                            </div>
                            <div className="flex justify-between">
                                <span className="text-zinc-500">Delta 1s</span>
                                <MetricValue value={metrics.delta1s} />
                            </div>
                            <div className="flex justify-between">
                                <span className="text-zinc-500">Delta 5s</span>
                                <MetricValue value={metrics.delta5s} />
                            </div>
                        </div>

                        {/* Analysis Bars */}
                        <div className="grid grid-cols-2 gap-3 pt-2">
                            <ScoreBar label="Sweep" value={metrics.sweepFadeScore} colorClass="bg-purple-500" />
                            <ScoreBar label="Breakout" value={metrics.breakoutScore} colorClass="bg-orange-500" />
                            <ScoreBar label="Absorption" value={metrics.absorptionScore} colorClass="bg-yellow-400" />
                            <ScoreBar label="Regime" value={metrics.regimeWeight} colorClass="bg-cyan-500" />
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
