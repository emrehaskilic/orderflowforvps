# Orderflow Matrix with Binance Proxy Server

## Overview

This project implements an orderflow analysis dashboard with a backend proxy server that handles all Binance API requests to avoid 418/429 rate limit errors.

### Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Frontend      │     │  Proxy Server   │     │   Binance       │
│   (Vite/React)  │────▶│  (Express + WS) │────▶│   API/WS        │
│   Port: 5173    │     │   Port: 8787    │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Key Benefits:**
- No direct Binance requests from browser (avoids 418/429 anti-bot errors)
- Server-side rate limiting and backoff
- In-memory caching for depth snapshots
- Single WebSocket connection to Binance shared across clients

---

## Quick Start (Local Development)

### 1. Install Dependencies

```bash
# Install all dependencies (root + server)
npm run install:all
```

### 2. Run Both Server and Client

```bash
# This starts both the proxy server (port 8787) and Vite frontend (port 5173)
npm run dev:all
```

### 3. Open Browser

Navigate to: **http://localhost:5173**

---

## Project Structure

```
orderflowforvps/
├── server/                 # Backend proxy server
│   ├── index.ts            # Main server file (Express + WebSocket)
│   ├── package.json        # Server dependencies
│   └── tsconfig.json       # TypeScript config for server
├── services/               # Frontend services (modified for proxy)
│   ├── OrderBookEngine.ts  # Now uses PROXY_HTTP_BASE
│   └── useBinanceSocket.ts # Now uses PROXY_WS_BASE
├── components/             # UI components (unchanged)
├── package.json            # Root package.json with dev:all script
├── .env.example            # Example environment variables
└── README.md               # This file
```

---

## Environment Variables

### Frontend (.env or .env.local)

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_PROXY_HTTP` | `http://localhost:8787` | HTTP proxy URL for depth snapshots |
| `VITE_PROXY_WS` | `ws://localhost:8787` | WebSocket proxy URL for streams |

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8787` | Server port |

---

## API Endpoints

### Health Check
```
GET /health
```
Response:
```json
{
  "ok": true,
  "uptime": 3600,
  "wsClients": 2,
  "binanceWsState": "connected",
  "cacheSize": 3,
  "activeSymbols": ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
}
```

### Depth Snapshot
```
GET /api/depth/:symbol?limit=1000
```
Response:
```json
{
  "lastUpdateId": 123456789,
  "bids": [["50000.00", "1.5"], ...],
  "asks": [["50001.00", "2.0"], ...],
  "cachedAt": 1699999999999,
  "source": "binance" // or "cache"
}
```

### WebSocket
```
WS /ws?symbols=BTCUSDT,ETHUSDT,SOLUSDT
```
Forwards Binance combined stream messages in the same format:
```json
{
  "stream": "btcusdt@depth@100ms",
  "data": { ... }
}
```

---

## VPS Deployment (Windows)

### 1. Install Node.js 18+

Download and install from: https://nodejs.org/

### 2. Clone and Install

```bash
git clone https://github.com/emrehaskilic/orderflowforvps.git
cd orderflowforvps
npm run install:all
```

### 3. Build Server

```bash
cd server
npm run build
```

### 4. Configure Environment

Create `.env.local` in the root directory:
```env
VITE_PROXY_HTTP=http://<VPS_PUBLIC_IP>:8787
VITE_PROXY_WS=ws://<VPS_PUBLIC_IP>:8787
```

### 5. Run Server with PM2

```bash
# Install PM2 globally
npm install -g pm2

# Install Windows service support
npm install -g pm2-windows-startup
pm2-startup install

# Start the server
cd server
pm2 start dist/index.js --name "orderflow-proxy"

# Save the process list
pm2 save
```

### 6. Alternative: NSSM (Windows Service)

1. Download NSSM: https://nssm.cc/download
2. Install as service:
```cmd
nssm install OrderflowProxy "C:\Program Files\nodejs\node.exe" "C:\path\to\orderflowforvps\server\dist\index.js"
nssm set OrderflowProxy AppDirectory "C:\path\to\orderflowforvps\server"
nssm start OrderflowProxy
```

### 7. Firewall

Open port 8787 for both TCP (HTTP) and WebSocket:
```powershell
New-NetFirewallRule -DisplayName "Orderflow Proxy" -Direction Inbound -LocalPort 8787 -Protocol TCP -Action Allow
```

### 8. Build Frontend (Optional)

```bash
cd ..  # Back to root
npm run build
# Serve the dist folder with any static server
npx serve dist
```

---

## Troubleshooting

### OBI/Orderbook still shows 0 or frozen

1. Check proxy server is running: `curl http://localhost:8787/health`
2. Check browser console for WebSocket connection errors
3. Verify no direct Binance requests in Network tab

### 503 "Depth data unavailable"

- Binance is rate limiting the proxy server
- Wait for backoff period to expire
- Check `/health` endpoint for `binanceWsState`

### WebSocket disconnects frequently

- Check VPS firewall rules
- Verify port 8787 is open
- Check proxy server logs for reconnection attempts

---

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run install:all` | Install all dependencies |
| `npm run dev` | Start Vite frontend only |
| `npm run dev:server` | Start proxy server only |
| `npm run dev:all` | Start both server and frontend |
| `npm run build` | Build frontend |
| `npm run build:server` | Build server |
| `npm run build:all` | Build both |

---

## License

MIT
