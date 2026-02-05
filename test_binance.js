
async function test() {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    for (const symbol of symbols) {
        try {
            const url = `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=100`;
            const res = await fetch(url);
            console.log(`${symbol}: ${res.status} ${res.statusText}`);
            if (!res.ok) {
                const text = await res.text();
                console.log(`Error body: ${text}`);
            }
        } catch (e) {
            console.error(`${symbol} Error:`, e);
        }
    }
}
test();
