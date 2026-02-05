import React, { useState, useEffect } from 'react';
import { useBinanceSocket } from '../services/useBinanceSocket';
import { SymbolRow } from './SymbolRow';

interface ExchangeInfoSymbol {
    symbol: string;
    status: string;
    contractType: string;
    quoteAsset: string;
}

export const Dashboard: React.FC = () => {
    // Start with a few popular pairs
    const [selectedPairs, setSelectedPairs] = useState<string[]>(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    const [availablePairs, setAvailablePairs] = useState<string[]>([]);
    const [searchTerm, setSearchTerm] = useState("");
    const [isDropdownOpen, setDropdownOpen] = useState(false);
    const [isLoadingPairs, setIsLoadingPairs] = useState(true);

    // Connect to WebSocket
    const marketData = useBinanceSocket(selectedPairs);

    // Fetch all USDT Futures pairs
    useEffect(() => {
        const fetchPairs = async () => {
            try {
                const res = await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo');
                const data = await res.json();
                const pairs = data.symbols
                    .filter((s: ExchangeInfoSymbol) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
                    .map((s: ExchangeInfoSymbol) => s.symbol)
                    .sort();
                
                setAvailablePairs(pairs);
                setIsLoadingPairs(false);
            } catch (error) {
                console.error("Failed to fetch pairs", error);
                // Fallback
                setAvailablePairs(["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "BNBUSDT"]);
                setIsLoadingPairs(false);
            }
        };

        fetchPairs();
    }, []);

    const togglePair = (pair: string) => {
        if (selectedPairs.includes(pair)) {
            setSelectedPairs(selectedPairs.filter(p => p !== pair));
        } else {
            setSelectedPairs([...selectedPairs, pair]);
        }
    };

    const filteredPairs = availablePairs.filter(p => p.includes(searchTerm.toUpperCase()));

    return (
        <div className="min-h-screen bg-[#09090b] text-zinc-200 font-sans p-6">
            <div className="max-w-7xl mx-auto">
                
                {/* Header Section */}
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
                    <div>
                        <h1 className="text-2xl font-bold text-white tracking-tight">Orderflow Matrix</h1>
                        <p className="text-zinc-500 text-sm mt-1">Binance Futures Real-time Analytics</p>
                    </div>

                    {/* Pair Selector */}
                    <div className="relative z-50">
                        <button 
                            onClick={() => setDropdownOpen(!isDropdownOpen)}
                            className="flex items-center space-x-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-white px-4 py-2 rounded-lg transition-all text-sm font-medium"
                        >
                            <span>{isLoadingPairs ? 'Loading Pairs...' : 'Select Pairs'}</span>
                            <span className="bg-zinc-700 text-xs px-1.5 py-0.5 rounded-full">{selectedPairs.length}</span>
                            <svg className="w-4 h-4 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                        </button>
                        
                        {isDropdownOpen && !isLoadingPairs && (
                            <div className="absolute right-0 mt-2 w-64 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden flex flex-col z-[100]">
                                <div className="p-2 border-b border-zinc-800">
                                    <input 
                                        type="text" 
                                        placeholder="Search..." 
                                        className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500"
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                        autoFocus
                                    />
                                </div>
                                <div className="max-h-60 overflow-y-auto p-2 space-y-1">
                                    {filteredPairs.map(pair => (
                                        <div 
                                            key={pair}
                                            onClick={() => togglePair(pair)}
                                            className={`flex items-center justify-between px-3 py-2 rounded cursor-pointer text-sm ${selectedPairs.includes(pair) ? 'bg-blue-900/30 text-blue-400' : 'hover:bg-zinc-800 text-zinc-400'}`}
                                        >
                                            <span>{pair}</span>
                                            {selectedPairs.includes(pair) && (
                                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                            )}
                                        </div>
                                    ))}
                                    {filteredPairs.length === 0 && (
                                        <div className="p-2 text-center text-xs text-zinc-500">No pairs found</div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Table Header */}
                <div className="bg-zinc-900/80 border border-zinc-800 rounded-t-xl overflow-hidden">
                    <div className="grid grid-cols-12 gap-4 p-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider border-b border-zinc-800">
                        <div className="col-span-2">Symbol</div>
                        <div className="col-span-2">Price</div>
                        <div className="col-span-2">OBI (W)</div>
                        <div className="col-span-2">Delta Z</div>
                        <div className="col-span-2">CVD Slope</div>
                        <div className="col-span-1">Signal</div>
                        <div className="col-span-1 text-right">Status</div>
                    </div>

                    {/* Table Body */}
                    <div className="bg-black/20 divide-y divide-zinc-800/50">
                        {selectedPairs.map(symbol => {
                            const data = marketData[symbol];
                            // Wait for data to arrive
                            if (!data || data.metrics.price === 0) return null; 

                            return (
                                <SymbolRow key={symbol} symbol={symbol} data={data} />
                            );
                        })}
                        
                        {selectedPairs.length === 0 && (
                            <div className="p-12 text-center text-zinc-600">
                                Select a trading pair to begin monitoring.
                            </div>
                        )}

                        {Object.keys(marketData).length === 0 && selectedPairs.length > 0 && (
                            <div className="p-12 text-center text-zinc-500 animate-pulse">
                                Connecting to Binance Stream...
                            </div>
                        )}
                    </div>
                </div>
                
                <div className="mt-6 text-xs text-zinc-600 text-center">
                    Data provided via WebSocket from Binance Futures. Calculations (VWAP, Delta, OBI, Absorption) are performed client-side relative to session start.
                </div>
            </div>
        </div>
    );
};