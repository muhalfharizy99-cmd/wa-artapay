require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const path = require('path');

const config = require('./src/config/config');
const MySQLSessionStore = require('./src/db/sessionStore');
const apiRoutes     = require('./src/routes/api');
const authRoutes    = require('./src/routes/auth');
const devicesRoutes = require('./src/routes/devices');
const blastRoutes   = require('./src/routes/blast');
const settingsRoutes = require('./src/routes/settings');
const waService  = require('./src/services/whatsappService');
const { migrate } = require('./src/db/migrate');

const isProduction = process.env.NODE_ENV === 'production';

// ─── Session Middleware ──────────────────────────────────────────────────────
const sessionMiddleware = session({
    store: new MySQLSessionStore(),
    secret: config.auth.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
    name: 'wa_sid',
    unset: 'destroy',
});

// ─── App Setup ────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
app.disable('x-powered-by');
if (isProduction) app.set('trust proxy', 1);

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws' });
const wsClients = new Set();

wss.on('connection', (ws, req) => {
    // Auth check — parse session from the upgrade request
    sessionMiddleware(req, {}, () => {
        if (!req.session?.authenticated) {
            ws.close(1008, 'Unauthorized');
            return;
        }
        _wsConnected(ws, req);
    });
});

function _wsConnected(ws, req) {
    wsClients.add(ws);
    console.log(`[WS] Client connected (total: ${wsClients.size}) from ${req.socket.remoteAddress || 'unknown'}`);

    // Send current status immediately for all known devices
    for (const [deviceId] of waService._clients.entries()) {
        const status = waService.getStatus(deviceId);
        ws.send(JSON.stringify({
            event: 'status',
            data: status,
            timestamp: new Date().toISOString(),
        }));
        if (status.qrBase64) {
            ws.send(JSON.stringify({
                event: 'qr',
                data: { qr: status.qrCode, qrBase64: status.qrBase64, device_id: deviceId },
                timestamp: new Date().toISOString(),
            }));
        }
    }

    // Fallback so client gets at least one status payload
    if (waService._clients.size === 0) {
        ws.send(JSON.stringify({
            event: 'status',
            data: waService.getStatus(),
            timestamp: new Date().toISOString(),
        }));
    }

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            handleWsMessage(ws, msg);
        } catch {
            ws.send(JSON.stringify({ event: 'error', data: { message: 'Invalid JSON' } }));
        }
    });

    ws.on('close', (code, reason) => {
        wsClients.delete(ws);
        console.log(`[WS] Client disconnected (code: ${code}, reason: ${reason || 'none'}, total: ${wsClients.size})`);
    });

    ws.on('error', (err) => {
        console.error('[WS] Error:', err.message);
        wsClients.delete(ws);
    });
}

function handleWsMessage(ws, msg) {
    const { action, data } = msg;
    const requestedDeviceId = data?.device_id || null;
    switch (action) {
        case 'ping':
            ws.send(JSON.stringify({ event: 'pong', data: { ts: Date.now() } }));
            break;
        case 'get_status':
            ws.send(JSON.stringify({ event: 'status', data: waService.getStatus(requestedDeviceId), timestamp: new Date().toISOString() }));
            break;
        case 'get_qr':
            {
                const status = waService.getStatus(requestedDeviceId);
                if (status.qrBase64) {
                    ws.send(JSON.stringify({ event: 'qr', data: { qrBase64: status.qrBase64, device_id: status.device_id }, timestamp: new Date().toISOString() }));
                } else {
                    ws.send(JSON.stringify({ event: 'error', data: { message: 'No QR available' } }));
                }
            }
            break;
        default:
            ws.send(JSON.stringify({ event: 'error', data: { message: `Unknown action: ${action}` } }));
    }
}

// Pass ws clients to WA service for broadcasting
waService.setWsClients(wsClients);

app.use(sessionMiddleware);

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
}));
app.use(cors({
    credentials: true,
}));
// Clean minimal logger — skips static assets, health checks, and browser noise
app.use((req, res, next) => {
    const skip = ['.js','.css','.png','.ico','.map','.well-known','/favicon','/backend-health','/frontend-config'];
    if (skip.some(s => req.path.includes(s))) return next();
    // Skip repeated GET / polling
    if (req.method === 'GET' && (req.path === '/' || req.path === '/status')) return next();
    const start = Date.now();
    res.on('finish', () => {
        const ms   = Date.now() - start;
        const code = res.statusCode;
        // Only log errors and slow requests for common endpoints
        if (code < 400 && ms < 500 && ['/me', '/message-logs', '/message-logs/stats', '/message-logs/conversations'].includes(req.path)) return;
        const color = code >= 500 ? '\x1b[31m' : code >= 400 ? '\x1b[33m' : code >= 300 ? '\x1b[36m' : '\x1b[32m';
        console.log(`${color}${req.method}\x1b[0m ${req.path} \x1b[90m${code} ${ms}ms\x1b[0m`);
    });
    next();
});
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    message: { success: false, message: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
});
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Too many login attempts, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
});
app.use('/api', limiter);
app.use('/auth/login', authLimiter);

// ─── Routes ────────────────────────────────────────────────────────────────────
app.get('/qr', (req, res) => {
    const requestedDeviceId = req.query.device_id || null;
    const status = waService.getStatus(requestedDeviceId);
    if (status.status !== 'qr' || !status.qrBase64) {
        return res.status(404).json({ success: false, message: 'No QR code available' });
    }
    res.json({ success: true, data: { qr: status.qrBase64, device_id: status.device_id } });
});
app.use('/api', apiRoutes);
app.use('/auth', authRoutes);
app.use('/devices', devicesRoutes);
app.use('/api', blastRoutes);
app.use('/api', settingsRoutes);
// ─── Frontend config (was in frontend.js) ──────────────────────────────────────
app.get('/frontend-config', (req, res) => {
    res.json({
        backendUrl:   `http://${config.server.host}:${config.server.port}`,
        frontendPort: config.server.port,
        apiPort:      config.server.port,
        host:         config.server.host,
    });
});

app.get('/backend-health', (req, res) => {
    res.json({ connected: true, backendUrl: `http://${config.server.host}:${config.server.port}` });
});

// ─── Static files & SPA routes ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

const ALLOWED_VIEWS = ['dashboard', 'device', 'messages', 'testing', 'logs', 'docs', 'users', 'history'];
app.get('/views/:view', (req, res) => {
    const name = req.params.view.replace(/\.html$/, '').replace(/[^a-z]/g, '');
    if (!ALLOWED_VIEWS.includes(name)) return res.status(404).end();
    res.sendFile(path.join(__dirname, 'public', 'views', `${name}.html`));
});

const FRONTEND_ROUTES = [
    '/',
    '/dashboard',
    '/device',
    '/messages',
    '/testing',
    '/blast',
    '/blast/contact',
    '/blast/campaign',
    '/blast/logs',
    '/history',
    '/logs',
    '/webhooks',
    '/docs',
    '/users',
    '/settings',
];

app.get(FRONTEND_ROUTES, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` });
});

// ─── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[ERR]', err.message);
    res.status(500).json({ success: false, message: err.message || 'Internal server error' });
});

// ─── Start Server (after DB migration) ────────────────────────────────────────
migrate()
    .then(() => {
        server.listen(config.server.port, () => {
            console.log('╔════════════════════════════════════════╗');
            console.log('║        WA GATEWAY - NODE.JS            ║');
            console.log('╠════════════════════════════════════════╣');
            console.log(`║  HTTP : http://${config.server.host}:${config.server.port}          ║`);
            console.log(`║  WS   : ws://${config.server.host}:${config.server.port}/ws         ║`);
            console.log(`║  API  : http://${config.server.host}:${config.server.port}/api      ║`);
            console.log('╚════════════════════════════════════════╝');
            // Auto-start: only initialize devices that have authenticated sessions (not new/unauthenticated devices)
            const { query: dbQuery } = require('./src/db/database');
            dbQuery('SELECT device_id FROM devices WHERE active = 1 ORDER BY updated_at DESC')
                .then(devices => {
                    if (!devices.length) {
                        console.log('[SERVER] No active devices found.');
                        return;
                    }
                    for (const dev of devices) {
                        const hasStoredSession = waService._hasStoredSession(dev.device_id);
                        if (!hasStoredSession) {
                            console.log(`[SERVER] Device "${dev.device_id}" has no stored session — skipping auto-start (connect manually from device panel)`);
                            continue;
                        }
                        console.log(`[SERVER] Auto-initializing device "${dev.device_id}" (stored session found)...`);
                        waService.setCurrentDevice(dev.device_id);
                        waService.initialize(dev.device_id).catch(err =>
                            console.error(`[WA] Init error for ${dev.device_id}:`, err.message)
                        );
                    }
                })
                .catch(() => {
                    console.log('[SERVER] Could not check active devices — start WhatsApp from the device panel.');
                });
        });
    })
    .catch(err => {
        console.error('[DB] Migration failed:', err.message);
        console.error('[DB] Check your MySQL settings in .env (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME)');
        process.exit(1);
    });

server.setMaxListeners(20);

let isShuttingDown = false;
server.on('error', (err) => {
    console.error('[SERVER] Error:', err.message);
    process.exit(1);
});

async function gracefulShutdown(signal) {
    if (isShuttingDown) {
        console.log(`[SERVER] Already shutting down, ignoring ${signal}`);
        return;
    }
    isShuttingDown = true;
    console.log(`\n[SERVER] ${signal} received — shutting down gracefully (sessions preserved)...`);
    const deviceIds = [...waService._clients.keys()];
    await Promise.all(deviceIds.map(id => waService.stop(id).catch(() => {})));
    
    setTimeout(() => {
        console.log('[SERVER] Force exiting after timeout');
        process.exit(0);
    }, 10000);
    
    server.close(() => {
        console.log('[SERVER] Closed successfully');
        process.exit(0);
    });
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED]', reason);
});
