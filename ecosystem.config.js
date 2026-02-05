module.exports = {
    apps: [{
        name: "binance-proxy",
        script: "./server/dist/index.js",
        env: {
            PORT: 8787,
            NODE_ENV: "production"
        }
    }, {
        name: "frontend-client",
        script: "npm",
        args: "run dev",
        env: {
            NODE_ENV: "development"
        }
    }]
}
