require('dotenv').config();
const express    = require('express');
const http       = require('http');
const https      = require('https');
const path       = require('path');
const { createProxyMiddleware } = require('http-proxy-middleware');

const FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT || 3000);
const API_PORT      = parseInt(process.env.PORT          || 3003);
const API_HOST      = process.env.HOST                   || 'localhost';
const API_TARGET    = `http://${API_HOST}:${API_PORT}`;

const app = express();

// ─── Frontend config endpoint (read from .env, not proxied) ──────────────────
app.get('/frontend-config', (req, res) => {
    res.json({
        backendUrl:   API_TARGET,
        frontendPort: FRONTEND_PORT,
        apiPort:      API_PORT,
        host:         API_HOST,
    });
});

// Backend health-check (pinged by the UI to show connection status)
app.get('/backend-health', (req, res) => {
    const url = `${API_TARGET}/api/status`;
    const mod = url.startsWith('https') ? https : http;
    const req2 = mod.get(url, { timeout: 3000 }, (r) => {
        res.json({ connected: r.statusCode < 500, backendUrl: API_TARGET });
        r.resume();
    });
    req2.on('error', () => res.json({ connected: false, backendUrl: API_TARGET }));
    req2.on('timeout', () => { req2.destroy(); res.json({ connected: false, backendUrl: API_TARGET }); });
});

// ─── Proxy: use pathFilter so paths are forwarded intact (no prefix stripping) ─
const proxyHttpError = (err, req, res) => {
    console.error('[PROXY] Error:', err.message);
    if (res && typeof res.status === 'function' && !res.headersSent) {
        res.status(502).json({ success: false, message: 'Backend unavailable — is server.js running?' });
    }
};

const proxyWsError = (err, req, socket) => {
    console.error('[PROXY][WS] Error:', err.message);
    try {
        if (socket && typeof socket.end === 'function') socket.end();
        else if (socket && typeof socket.destroy === 'function') socket.destroy();
    } catch {}
};

// WebSocket proxy (handles /ws upgrade)
const wsProxy = createProxyMiddleware({
    target:       API_TARGET,
    changeOrigin: true,
    ws:           true,
    pathFilter:   '/ws',
    on: { error: proxyWsError },
});

// HTTP proxy — pathFilter keeps full path intact (no stripping)
app.use(createProxyMiddleware({
    target:       API_TARGET,
    changeOrigin: true,
    pathFilter:   ['/api', '/auth', '/devices', '/qr', '/status'],
    on: { error: proxyHttpError },
}));

app.use(wsProxy);

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ─── HTML routes ──────────────────────────────────────────────────────────────
const PUB = path.join(__dirname, 'public');

app.get('/login', (req, res) => res.sendFile(path.join(PUB, 'login.html')));

// Protected view partials — serve HTML directly; API auth enforces access
const ALLOWED_VIEWS = ['dashboard', 'device', 'messages', 'testing', 'logs', 'docs', 'users', 'history'];
app.get('/views/:view', (req, res) => {
    const name = req.params.view.replace(/\.html$/, '').replace(/[^a-z]/g, '');
    if (!ALLOWED_VIEWS.includes(name)) return res.status(404).end();
    res.sendFile(path.join(PUB, 'views', `${name}.html`));
});

// SPA catch-all — serve index.html for all other routes
app.get('*', (req, res) => res.sendFile(path.join(PUB, 'index.html')));

// ─── Start ────────────────────────────────────────────────────────────────────
const server = http.createServer(app);

// Forward WebSocket upgrade events through the proxy
server.on('upgrade', wsProxy.upgrade);

server.listen(FRONTEND_PORT, API_HOST, () => {
    console.log('╔════════════════════════════════════════╗');
    console.log('║      WA GATEWAY — FRONTEND SERVER      ║');
    console.log('╠════════════════════════════════════════╣');
    console.log(`║  UI  : http://${API_HOST}:${FRONTEND_PORT}           ║`);
    console.log(`║  API : ${API_TARGET} (proxied)   ║`);
    console.log('╚════════════════════════════════════════╝');
});

server.on('error', (err) => {
    console.error('[FRONTEND] Error:', err.message);
    process.exit(1);
});
