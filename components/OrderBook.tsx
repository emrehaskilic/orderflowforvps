import React from 'react';
import { OrderBookLevel } from '../types';

interface OrderBookProps {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
    currentPrice: number;
}

export const OrderBook: React.FC<OrderBookProps> = ({ bids, asks, currentPrice }) => {
    // Only show top 8 levels
    const displayBids = bids.slice(0, 8);
    const displayAsks = asks.slice(0, 8).reverse(); // Show lowest ask at bottom of top section

    const maxTotal = Math.max(
        (displayBids[displayBids.length - 1]?.total || 0),
        (displayAsks[0]?.total || 0) * 1.5 // Multiplier just for visual scale
    ) || 1;

    return (
        <div className="w-full text-xs font-mono bg-zinc-950 p-2 rounded border border-zinc-800">
            <div className="flex justify-between text-zinc-500 mb-1 px-1">
                <span>Price</span>
                <span>Size</span>
                <span>Total</span>
            </div>
            
            {/* Asks (Sellers) - Red */}
            <div className="flex flex-col-reverse">
                {displayAsks.map((level, i) => (
                    <div key={`ask-${i}`} className="relative flex justify-between px-1 py-0.5 hover:bg-zinc-800">
                         {/* Depth Bar */}
                         <div 
                            className="absolute right-0 top-0 bottom-0 bg-red-500/10 z-0" 
                            style={{ width: `${(level.total / maxTotal) * 100}%` }}
                        />
                        <span className="text-red-400 z-10">{level.price.toFixed(2)}</span>
                        <span className="text-zinc-300 z-10">{level.size.toFixed(3)}</span>
                        <span className="text-zinc-500 z-10">{level.total.toFixed(1)}</span>
                    </div>
                ))}
            </div>

            <div className="text-center py-2 text-lg font-bold text-white border-y border-zinc-800 my-1">
                {currentPrice.toFixed(2)}
            </div>

            {/* Bids (Buyers) - Green */}
            <div>
                {displayBids.map((level, i) => (
                    <div key={`bid-${i}`} className="relative flex justify-between px-1 py-0.5 hover:bg-zinc-800">
                         {/* Depth Bar */}
                         <div 
                            className="absolute right-0 top-0 bottom-0 bg-green-500/10 z-0" 
                            style={{ width: `${(level.total / maxTotal) * 100}%` }}
                        />
                        <span className="text-green-400 z-10">{level.price.toFixed(2)}</span>
                        <span className="text-zinc-300 z-10">{level.size.toFixed(3)}</span>
                        <span className="text-zinc-500 z-10">{level.total.toFixed(1)}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};