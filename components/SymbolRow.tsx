import React, { useState } from 'react';
import { AppState } from '../types';
import { formatCurrency, formatNumber } from '../services/mathUtils';
import { OrderBook } from './OrderBook';

interface SymbolRowProps {
    symbol: string;
    data: AppState[string];
}

const MetricValue: React.FC<{ value: number; format?: string; reverseColor?: boolean }> = ({ value, format = 'number', reverseColor = false }) => {
    let color = 'text-zinc-300';
    // Use threshold for coloring
    if (value > 0.0001) color = reverseColor ? 'text-red-500' : 'text-green-500';
    if (value < -0.0001) color = reverseColor ? 'text-green-500' : 'text-red-500';

    const formatted = format === 'currency' ? formatCurrency(value) 
        : format === 'percent' ? `${(value * 100).toFixed(1)}%` 
        : value.toFixed(2);

    return <span className={`font-mono font-medium ${color}`}>{formatted}</span>;
};

// Small sparkline or icon for slope
const SlopeIcon: React.FC<{ value: number }> = ({ value }) => {
    if (Math.abs(value) < 0.1) return <span className="text-zinc-600">~</span>;
    return value > 0 
        ? <svg className="w-4 h-4 text-green-500 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
        : <svg className="w-4 h-4 text-red-500 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" /></svg>;
}

const ScoreBar: React.FC<{ label: string; value: number; colorClass: string; max?: number }> = ({ label, value, colorClass, max = 100 }) => {
    const percent = Math.min(100, Math.max(0, (Math.abs(value) / max) * 100));
    return (
        <div className="flex flex-col gap-1">
            <div className="flex justify-between text-[10px] text-zinc-500 uppercase tracking-wider">
                <span>{label}</span>
                <span className="text-zinc-300 font-mono">{value.toFixed(1)}</span>
            </div>
            <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
                <div 
                    className={`h-full ${colorClass} transition-all duration-500`}
                    style={{ width: `${percent}%` }}
                ></div>
            </div>
        </div>
    );
};

export const SymbolRow: React.FC<SymbolRowProps> = ({ symbol, data }) => {
    const [expanded, setExpanded] = useState(false);
    const { metrics, bids, asks } = data;

    return (
        <div className="border-b border-zinc-800/50 hover:bg-zinc-900/50 transition-colors">
            {/* Main Row Header */}
            <div 
                className="grid grid-cols-12 gap-4 p-4 items-center cursor-pointer select-none"
                onClick={() => setExpanded(!expanded)}
            >
                <div className="col-span-2 flex items-center space-x-2">
                    <button className="text-zinc-500 hover:text-white transition-colors">
                        <svg className={`w-4 h-4 transform transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                    </button>
                    <span className="font-bold text-white">{symbol}</span>
                    <span className="text-[10px] px-1.5 py-0.5 bg-zinc-800 text-zinc-400 rounded border border-zinc-700">PERP</span>
                </div>

                <div className="col-span-2 font-mono text-zinc-200">{formatCurrency(metrics.price)}</div>
                
                <div className="col-span-2 flex items-center space-x-2">
                     <MetricValue value={metrics.obiWeighted} />
                </div>

                <div className="col-span-2">
                    {/* Changed label to Z-Score for accuracy */}
                    <MetricValue value={metrics.deltaZ} />
                </div>

                <div className="col-span-2 flex items-center space-x-2">
                    <SlopeIcon value={metrics.cvdSlope} />
                    <MetricValue value={metrics.cvdSlope} />
                </div>

                {/* Removed Signal Col as per guidelines */}
                <div className="col-span-1">
                     <span className="text-xs text-zinc-600">-</span>
                </div>
                
                <div className="col-span-1 text-right">
                    <span className="text-xs px-2 py-1 rounded border border-green-900 bg-green-900/20 text-green-500 font-mono">LIVE</span>
                </div>
            </div>

            {/* Expanded Content */}
            {expanded && (
                <div className="bg-zinc-900/30 border-t border-zinc-800 p-4 grid grid-cols-12 gap-6 animate-in fade-in slide-in-from-top-2 duration-200">
                    
                    {/* Left Stats Column */}
                    <div className="col-span-3 space-y-4">
                        <div className="bg-zinc-950 p-3 rounded border border-zinc-800">
                            <p className="text-zinc-500 text-xs mb-1">Session VWAP</p>
                            <p className="font-mono text-blue-300">{formatCurrency(metrics.vwap)}</p>
                        </div>
                        
                        <div className="space-y-2 pt-2">
                            <div className="flex justify-between text-sm">
                                <span className="text-zinc-500">OBI (Weighted)</span>
                                <MetricValue value={metrics.obiWeighted} />
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-zinc-500">OBI (Deep Book)</span>
                                <MetricValue value={metrics.obiSpoof} />
                            </div>
                             <div className="flex justify-between text-sm">
                                {/* Renamed from Spoof Ratio to OBI Divergence for accuracy */}
                                <span className="text-zinc-500">OBI Divergence</span>
                                <span className="font-mono text-zinc-300">
                                    {(Math.abs(metrics.obiWeighted - metrics.obiSpoof) * 100).toFixed(1)}%
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* Middle OrderBook Column */}
                    <div className="col-span-5">
                         <div className="mb-2 flex justify-between items-end">
                            <h4 className="text-zinc-400 text-sm font-semibold">Live Orderbook</h4>
                            <span className="text-xs text-zinc-600">Depth 20 Sync</span>
                         </div>
                         <OrderBook bids={bids} asks={asks} currentPrice={metrics.price} />
                    </div>

                    {/* Right Stats Column */}
                    <div className="col-span-4 space-y-4">
                        <div className="space-y-2 pt-2">
                            <div className="flex justify-between text-sm">
                                <span className="text-zinc-500">Delta 1s (Rolling)</span>
                                <MetricValue value={metrics.delta1s} />
                            </div>
                             <div className="flex justify-between text-sm">
                                <span className="text-zinc-500">Delta 5s (Rolling)</span>
                                <MetricValue value={metrics.delta5s} />
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-zinc-500">CVD (Session)</span>
                                <MetricValue value={metrics.cvd} />
                            </div>
                            
                            {/* Visual Bar for Pressure */}
                            <div className="pt-4 border-t border-zinc-800/50 mt-4">
                                <div className="flex justify-between text-xs text-zinc-500 mb-1">
                                    <span>Bid Pressure</span>
                                    <span>Ask Pressure</span>
                                </div>
                                <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden flex mb-2">
                                    <div 
                                        className="h-full bg-green-500 transition-all duration-500"
                                        style={{ width: `${50 + (metrics.obiWeighted * 50)}%` }}
                                    ></div>
                                </div>

                                {/* NEW ADVANCED METRICS */}
                                <div className="grid grid-cols-2 gap-4 mt-4 pt-2 border-t border-zinc-800 border-dashed">
                                    <ScoreBar 
                                        label="Sweep Strength" 
                                        value={metrics.sweepFadeScore} 
                                        colorClass="bg-purple-500" 
                                    />
                                    <ScoreBar 
                                        label="Breakout Mom." 
                                        value={metrics.breakoutScore} 
                                        colorClass="bg-orange-500" 
                                    />
                                    <ScoreBar 
                                        label="Regime Vol" 
                                        value={metrics.regimeWeight} 
                                        colorClass="bg-cyan-500" 
                                    />
                                    <ScoreBar 
                                        label="Absorption" 
                                        value={metrics.absorptionScore} 
                                        colorClass="bg-yellow-400" 
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};