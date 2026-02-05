import React from 'react';
import { formatCurrency } from '../services/mathUtils';

export const MetricValue: React.FC<{ value: number; format?: string; reverseColor?: boolean }> = ({ value, format = 'number', reverseColor = false }) => {
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
export const SlopeIcon: React.FC<{ value: number }> = ({ value }) => {
    if (Math.abs(value) < 0.1) return <span className="text-zinc-600">~</span>;
    return value > 0
        ? <svg className="w-4 h-4 text-green-500 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
        : <svg className="w-4 h-4 text-red-500 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" /></svg>;
}

export const ScoreBar: React.FC<{ label: string; value: number; colorClass: string; max?: number }> = ({ label, value, colorClass, max = 100 }) => {
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
