const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('../config/config');
const webhookService = require('./webhookService');
const { query, queryOne } = require('../db/database');

const _IGNORED_LOG_TYPES = new Set([
    'e2e_notification',
    'notification',
    'notification_template',
    'call_log',
    'gp2',
    'revoked',
    'ciphertext',
    'protocol',
]);

function resolveChrome() {
    if (config.session.chromePath) return config.session.chromePath;
    const isWin = process.platform === 'win32';
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const platformPrefix = isWin ? 'win64-' : 'linux-';
    const subDir = isWin ? 'chrome-win64' : 'chrome-linux64';
    const chromeBin = isWin ? 'chrome.exe' : 'chrome';

    // 1. Project-local .chromium/ directory (portable, works on any machine)
    const localChromiumDir = path.resolve(process.cwd(), '.chromium', 'chrome');
    try {
        if (fs.existsSync(localChromiumDir)) {
            const versions = fs.readdirSync(localChromiumDir).filter(d => d.startsWith(platformPrefix));
            for (const v of versions.sort().reverse()) {
                const p = path.join(localChromiumDir, v, subDir, chromeBin);
                if (fs.existsSync(p)) return p;
            }
        }
    } catch {}

    // 2. Puppeteer user cache (~/.cache/puppeteer/chrome/)
    const puppeteerCache = path.join(home, '.cache', 'puppeteer', 'chrome');
    try {
        if (fs.existsSync(puppeteerCache)) {
            const versions = fs.readdirSync(puppeteerCache).filter(d => d.startsWith(platformPrefix));
            for (const v of versions.sort().reverse()) {
                const p = path.join(puppeteerCache, v, subDir, chromeBin);
                if (fs.existsSync(p)) return p;
            }
        }
    } catch {}

    // 3. System-installed Chrome / Chromium
    const candidates = isWin
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            'C:\\Program Files\\Chromium\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
        ]
        : [
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/snap/bin/chromium',
        ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch {}
    }
    return undefined;
}

function ensureSessionStorage() {
    try {
        fs.mkdirSync(config.session.path, { recursive: true });
        fs.mkdirSync(`${config.session.path}\\.wwebjs_auth`, { recursive: true });
    } catch (err) {
        throw new Error(`Cannot prepare WhatsApp session storage at '${config.session.path}': ${err.message}`);
    }
}

class WhatsAppService {
    constructor() {
        this.wsClients = new Set();
        this._typingTimers = new Map();
        this._sentMsgIds = new Map(); // dedup: sendText() vs message_create event → expiry timestamp
        this._processedIncomingMsgIds = new Map();
        this._processedIncomingContentKeys = new Map();
        this._inflightIncomingKeys = new Set();
        this._processedWebhookDispatchKeys = new Map();
        this._sentWebhookReplyKeys = new Map();
        this._outgoingSendDedup = new Map(); // nuclear: recipient+body → expiry
        this.currentDeviceId = config.session.name;
        this._pendingPairingResolvers = new Map();
        this._reconnectTimers = new Map(); // deviceId -> Timeout
        this._reconnectState = new Map();  // deviceId -> { attempts, lastAttemptAt, suppressUntil }
        this._staleErrorTracker = new Map(); // deviceId -> { count, firstAt }
        this._initPromises = new Map();
        this._healthMonitorTimer = null;
        this._healthMonitorRunning = false;
        // Per-device client state: deviceId → { client, status, qrCode, qrBase64, info, authMode }
        this._clients = new Map();

        this.startHealthMonitor();
    }

    startHealthMonitor(intervalMs = 2 * 60 * 1000) {
        if (this._healthMonitorTimer) return;
        const ms = Number.isFinite(Number(intervalMs)) ? Math.max(5000, Number(intervalMs)) : 2 * 60 * 1000;
        this._healthMonitorTimer = setInterval(() => {
            this._healthCheckTick().catch(() => {});
        }, ms);
    }

    stopHealthMonitor() {
        if (this._healthMonitorTimer) {
            clearInterval(this._healthMonitorTimer);
        }
        this._healthMonitorTimer = null;
    }

    async _healthCheckTick() {
        if (this._healthMonitorRunning) return;
        this._healthMonitorRunning = true;
        try {
            const rows = await query('SELECT device_id, active FROM devices WHERE active = 1');
            const activeDeviceIds = Array.isArray(rows)
                ? rows.map(r => String(r?.device_id || '').trim()).filter(Boolean)
                : [];
            if (!activeDeviceIds.length) return;

            for (const deviceId of activeDeviceIds) {
                const ds = this._devState(deviceId);

                if (ds.authMode === 'pairing') continue;
                if (ds.status === 'qr') continue;

                if (!ds.client) {
                    if (ds.status === 'disconnected' && this._hasStoredSession(deviceId)) {
                        this._scheduleReconnect(deviceId, 'health_monitor').catch(() => {});
                    }
                    continue;
                }

                // If status has been "connecting" for too long (>90s), force reconnect
                if (ds.status === 'connecting') {
                    const connectingTooLong = ds._connectingSince && (Date.now() - ds._connectingSince > 90000);
                    if (connectingTooLong) {
                        console.warn(`[WA][HEALTH] Device ${deviceId} stuck in 'connecting' for >90s — forcing reconnect`);
                        await this._forceReconnect(deviceId, 'health_monitor_connecting_timeout');
                    }
                    continue;
                }

                const isStillConnected = await this._isClientStillConnected(ds.client, deviceId).catch(() => false);
                if (isStillConnected) {
                    await this._promoteReadyIfConnected(ds.client, deviceId, 'health_monitor');
                    continue;
                }

                // Client not connected — check if stale or truly disconnected
                await this._markClientNeedsReconnect(deviceId, 'health_monitor_stale');
            }
        } catch (e) {
            console.warn(`[WA][HEALTH] Monitor tick failed: ${e?.message || e}`);
        } finally {
            this._healthMonitorRunning = false;
        }
    }

    _getReconnectState(deviceId) {
        const devId = String(deviceId || '').trim();
        if (!devId) return { attempts: 0, lastAttemptAt: 0, suppressUntil: 0 };
        if (!this._reconnectState.has(devId)) {
            this._reconnectState.set(devId, { attempts: 0, lastAttemptAt: 0, suppressUntil: 0 });
        }
        return this._reconnectState.get(devId);
    }

    _cancelReconnect(deviceId, reason = 'cancel') {
        const devId = String(deviceId || '').trim();
        if (!devId) return;
        const t = this._reconnectTimers.get(devId);
        if (t) clearTimeout(t);
        this._reconnectTimers.delete(devId);
        const st = this._getReconnectState(devId);
        st.lastAttemptAt = 0;
        console.log(`[WA][RECONNECT] Cancelled for ${devId} (${reason})`);
    }

    _suppressReconnect(deviceId, ms = 30000, reason = 'manual') {
        const devId = String(deviceId || '').trim();
        if (!devId) return;
        const st = this._getReconnectState(devId);
        st.suppressUntil = Date.now() + Math.max(0, Number(ms) || 0);
        this._cancelReconnect(devId, `suppressed:${reason}`);
    }

    async _isDeviceActive(deviceId) {
        try {
            const row = await queryOne('SELECT active FROM devices WHERE device_id = ? LIMIT 1', [deviceId]);
            return !!row?.active;
        } catch {
            return false;
        }
    }

    _hasStoredSession(deviceId) {
        const sessionFolders = [
            path.resolve(config.session.path, `session-${deviceId}`),
            path.resolve(config.session.path, '.wwebjs_auth', `session-${deviceId}`),
        ];
        return sessionFolders.some((dir) => {
            try {
                return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
            } catch {
                return false;
            }
        });
    }

    _hasAuthenticatedSession(deviceId) {
        // Check if session has auth token (indicates previously authenticated)
        const authFile = path.resolve(config.session.path, '.wwebjs_auth', `session-${deviceId}`, 'Default', 'Cookies');
        const sessionFile = path.resolve(config.session.path, `session-${deviceId}`, 'Local Storage', 'leveldb');
        try {
            // Check for auth indicators: Cookies file or session data
            const hasCookies = fs.existsSync(authFile);
            const hasSessionData = fs.existsSync(sessionFile) && fs.readdirSync(sessionFile).length > 0;
            return hasCookies || hasSessionData;
        } catch {
            return false;
        }
    }

    async _scheduleReconnect(deviceId, reason = 'disconnected') {
        const devId = String(deviceId || '').trim();
        if (!devId) return;
        if (!config.features?.autoReconnect) return;

        const ds = this._devState(devId);
        if (ds.authMode === 'pairing') {
            return; // pairing flow should be initiated manually
        }
        if (this._reconnectTimers.has(devId)) {
            return; // already scheduled
        }

        // Only auto-reconnect if there's a previous session; otherwise user must manually Connect/QR
        if (!this._hasStoredSession(devId)) {
            console.log(`[WA][RECONNECT] Skipped for ${devId} — no stored session, user must connect manually`);
            return;
        }

        const st = this._getReconnectState(devId);
        const now = Date.now();
        if (st.suppressUntil && st.suppressUntil > now) {
            return;
        }

        const isActive = await this._isDeviceActive(devId);
        if (!isActive) {
            console.log(`[WA][RECONNECT] Skipped for ${devId} (device inactive)`);
            return;
        }

        // Anti-spam: ensure a minimal cooldown between attempts
        const minCooldownMs = 10 * 1000;
        if (st.lastAttemptAt && (now - st.lastAttemptAt) < minCooldownMs) {
            return;
        }

        const attempt = Math.max(0, Number(st.attempts) || 0);
        const baseMs = 5000;
        const maxMs = 5 * 60 * 1000;
        const delayMs = Math.min(maxMs, baseMs * Math.pow(2, attempt));
        const jitterMs = Math.floor(Math.random() * 1000);
        const waitMs = delayMs + jitterMs;

        console.log(`[WA][RECONNECT] Scheduling reconnect for ${devId} in ${waitMs}ms (attempt ${attempt + 1}, reason: ${reason})`);
        const timer = setTimeout(async () => {
            this._reconnectTimers.delete(devId);
            const st2 = this._getReconnectState(devId);
            if (st2.suppressUntil && st2.suppressUntil > Date.now()) return;
            if (!(await this._isDeviceActive(devId))) return;

            // Only try reconnect if still disconnected and no active client
            const live = this.getStatus(devId);
            if (live.status !== 'disconnected') return;
            if (this._devState(devId).client) return;

            st2.attempts = Math.min(20, (Number(st2.attempts) || 0) + 1);
            st2.lastAttemptAt = Date.now();
            try {
                await this.initialize(devId);
            } catch (err) {
                console.error(`[WA][RECONNECT] Initialize failed for ${devId}:`, err?.message || err);
                // schedule next attempt
                this._scheduleReconnect(devId, 'init_error').catch(() => {});
            }
        }, waitMs);

        this._reconnectTimers.set(devId, timer);
    }

    // ── Per-device state – each device has its own WA client ───────────────────────
    _devState(deviceId) {
        const id = deviceId || this.currentDeviceId;
        if (!this._clients.has(id)) {
            this._clients.set(id, { client: null, status: 'disconnected', qrCode: null, qrBase64: null, info: null, authMode: 'qr', incomingAckReplyEnabled: false, webhookReplyDelay: 0 });
        }
        return this._clients.get(id);
    }

    // Backward-compat getters (server.js reads these directly for the current device)
    get client()   { return this._devState(this.currentDeviceId).client; }
    get status()   { return this._devState(this.currentDeviceId).status; }
    get qrCode()   { return this._devState(this.currentDeviceId).qrCode; }
    get qrBase64() { return this._devState(this.currentDeviceId).qrBase64; }
    get info()     { return this._devState(this.currentDeviceId).info; }

    setCurrentDevice(deviceId) {
        if (deviceId) this.currentDeviceId = deviceId;
    }

    setWsClients(wsClients) {
        this.wsClients = wsClients;
    }

    _broadcast(event, data) {
        const msg = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
        this.wsClients.forEach(ws => {
            if (ws.readyState === 1) ws.send(msg);
        });
    }

    _isActiveClient(client, deviceId) {
        return this._devState(deviceId).client === client;
    }

    async _destroyClient(deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        const ds = this._devState(devId);
        if (ds.client) {
            try {
                await ds.client.destroy();
            } catch {}
            ds.client = null;
            await this._wait(2500);
            this._killSessionChrome(devId);
            await this._wait(1500);
            this._cleanSessionLock(devId);
            this._killSessionChrome(devId);
            await this._wait(1000);
        }
        ds.status = 'disconnected';
        ds.qrCode = null;
        ds.qrBase64 = null;
        ds.info = null;
        ds.authMode = 'qr';
    }

    _killSessionChrome(deviceId) {
        const sessionDir = path.resolve(config.session.path, `session-${deviceId}`);
        const sessionDirAuth = path.resolve(config.session.path, '.wwebjs_auth', `session-${deviceId}`);
        try {
            if (process.platform === 'win32') {
                const out1 = execSync(
                    `wmic process where "name='chrome.exe'" get ProcessId,CommandLine /format:csv 2>nul`,
                    { encoding: 'utf-8', timeout: 8000 }
                ).trim();
                for (const line of out1.split('\n')) {
                    const lineLower = line.toLowerCase();
                    if (lineLower.includes(sessionDir.toLowerCase()) || lineLower.includes(sessionDirAuth.toLowerCase())) {
                        const parts = line.split(',').map(s => s.trim()).filter(Boolean);
                        const pid = parseInt(parts[parts.length - 1], 10);
                        if (pid > 0) {
                            try {
                                process.kill(pid, 'SIGKILL');
                                console.log(`[WA] Killed lingering chrome PID ${pid} for session ${deviceId}`);
                            } catch {}
                        }
                    }
                }
            } else {
                try {
                    execSync(`pkill -9 -f "${sessionDir}" 2>/dev/null || true`, { timeout: 5000 });
                    execSync(`pkill -9 -f "${sessionDirAuth}" 2>/dev/null || true`, { timeout: 5000 });
                } catch {}
            }
        } catch {}
    }

    _cleanSessionLock(deviceId) {
        // Remove Chromium SingletonLock file that prevents new browser launch
        const lockPaths = [
            path.join(config.session.path, `session-${deviceId}`, 'SingletonLock'),
            path.join(config.session.path, `session-${deviceId}`, 'SingletonCookie'),
            path.join(config.session.path, `session-${deviceId}`, 'SingletonSocket'),
            path.join(config.session.path, '.wwebjs_auth', `session-${deviceId}`, 'SingletonLock'),
            path.join(config.session.path, '.wwebjs_auth', `session-${deviceId}`, 'SingletonCookie'),
            path.join(config.session.path, '.wwebjs_auth', `session-${deviceId}`, 'SingletonSocket'),
        ];
        for (const lockFile of lockPaths) {
            try {
                if (fs.existsSync(lockFile)) {
                    fs.unlinkSync(lockFile);
                    console.log(`[WA] Removed session lock: ${lockFile}`);
                }
            } catch {}
        }
    }

    async _wait(ms) {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
    }

    async initialize(deviceId = null, initOptions = {}) {
        if (deviceId) this.setCurrentDevice(deviceId);
        const targetDeviceId = this.currentDeviceId;
        const runningInit = this._initPromises.get(targetDeviceId);
        if (runningInit) {
            return runningInit;
        }

        const initPromise = (async () => {
            const pairWithPhoneNumber = initOptions?.pairWithPhoneNumber || null;
            const nextAuthMode = pairWithPhoneNumber ? 'pairing' : 'qr';
            const ds = this._devState(targetDeviceId);
            if (ds.client && ds.authMode === nextAuthMode && ['connecting', 'qr', 'ready'].includes(ds.status)) {
                return this.getStatus(targetDeviceId);
            }
            if (ds.client && (ds.authMode !== nextAuthMode || ds.status === 'disconnected')) {
                await this._destroyClient(targetDeviceId);
            }
            ds.status = 'connecting';
            ds._connectingSince = Date.now();
            ds.qrCode = null;
            ds.qrBase64 = null;
            ds.info = null;
            ds.authMode = nextAuthMode;
            try {
                const row = await queryOne('SELECT incoming_ack_reply_enabled, webhook_reply_delay FROM devices WHERE device_id = ? LIMIT 1', [targetDeviceId]);
                ds.incomingAckReplyEnabled = !!row?.incoming_ack_reply_enabled;
                ds.webhookReplyDelay = row?.webhook_reply_delay || 0;
            } catch {}
            this._broadcast('status', { status: 'connecting', device_id: targetDeviceId });
            query('UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?', ['connecting', targetDeviceId]).catch(() => {});

            // If initialize() is called, clear any pending reconnect timer for this device
            this._cancelReconnect(targetDeviceId, 'initialize');

            const chromePath = resolveChrome();
            if (chromePath) {
                console.log(`[WA] Using Chrome: ${chromePath}`);
            } else {
                console.warn('[WA] No Chrome found. Set CHROME_PATH in .env or install via: npx puppeteer browsers install chrome');
            }

            ensureSessionStorage();

            const client = new Client({
                authStrategy: new LocalAuth({
                    clientId: targetDeviceId,
                    dataPath: config.session.path,
                }),
                pairWithPhoneNumber: pairWithPhoneNumber || undefined,
                puppeteer: {
                    headless: true,
                    executablePath: chromePath,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-gpu',
                        '--disable-default-apps',
                        '--disable-extensions',
                        '--disable-sync',
                        '--no-default-browser-check',
                        '--disable-background-timer-throttling',
                        '--disable-renderer-backgrounding',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-features=IsolateOrigins,site-per-process,TranslateUI',
                        '--disable-site-per-process',
                        '--disable-blink-features=AutomationControlled',
                        '--disable-infobars',
                        '--window-size=1280,720',
                        '--disable-component-update',
                        '--disable-hang-monitor',
                    ],
                    timeout: 120000,
                },
                webVersionCache: {
                    type: 'remote',
                    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1019656483.html',
                },
            });

            ds.client = client;
            this._registerEvents(client, targetDeviceId);
            try {
                await client.initialize();
            } catch (err) {
                const errMsg = String(err?.message || err || '');
                // If "browser is already running", clean up lingering process and retry once
                if (errMsg.includes('already running') || errMsg.includes('userDataDir')) {
                    console.warn(`[WA] Browser already running for ${targetDeviceId} — killing stale process and retrying`);
                    if (this._isActiveClient(client, targetDeviceId)) {
                        await client.destroy().catch(() => {});
                        ds.client = null;
                    }
                    await this._wait(2000);
                    this._killSessionChrome(targetDeviceId);
                    this._cleanSessionLock(targetDeviceId);
                    await this._wait(1000);
                    // Retry with a fresh Client instance
                    const client2 = new Client({
                        authStrategy: new LocalAuth({
                            clientId: targetDeviceId,
                            dataPath: config.session.path,
                        }),
                        pairWithPhoneNumber: pairWithPhoneNumber || undefined,
                        puppeteer: {
                            headless: true,
                            executablePath: chromePath,
                            args: [
                                '--no-sandbox',
                                '--disable-setuid-sandbox',
                                '--disable-dev-shm-usage',
                                '--disable-accelerated-2d-canvas',
                                '--no-first-run',
                                '--no-zygote',
                                '--disable-gpu',
                                '--disable-default-apps',
                                '--disable-extensions',
                                '--disable-sync',
                                '--no-default-browser-check',
                                '--disable-background-timer-throttling',
                                '--disable-renderer-backgrounding',
                                '--disable-backgrounding-occluded-windows',
                                '--disable-features=IsolateOrigins,site-per-process,TranslateUI',
                                '--disable-site-per-process',
                                '--disable-blink-features=AutomationControlled',
                                '--disable-infobars',
                                '--window-size=1280,720',
                                '--disable-component-update',
                                '--disable-hang-monitor',
                            ],
                            timeout: 120000,
                        },
                        webVersionCache: {
                            type: 'remote',
                            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1019656483.html',
                        },
                    });
                    ds.client = client2;
                    this._registerEvents(client2, targetDeviceId);
                    try {
                        await client2.initialize();
                        return; // retry succeeded
                    } catch (retryErr) {
                        if (this._isActiveClient(client2, targetDeviceId)) {
                            await client2.destroy().catch(() => {});
                            ds.client = null;
                            ds.status = 'disconnected';
                            ds.qrCode = null;
                            ds.qrBase64 = null;
                            ds.info = null;
                        }
                        this._rejectPairingWaiter(targetDeviceId, retryErr);
                        this._broadcast('status', { status: 'disconnected', device_id: targetDeviceId });
                        this._broadcast('init_error', { device_id: targetDeviceId, message: String(retryErr?.message || retryErr || 'Initialization failed after retry') });
                        query('UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?', ['disconnected', targetDeviceId]).catch(() => {});
                        throw retryErr;
                    }
                }
                if (this._isActiveClient(client, targetDeviceId)) {
                    await client.destroy().catch(() => {});
                    ds.client = null;
                    ds.status = 'disconnected';
                    ds.qrCode = null;
                    ds.qrBase64 = null;
                    ds.info = null;
                    this._rejectPairingWaiter(targetDeviceId, err);
                    this._broadcast('status', { status: 'disconnected', device_id: targetDeviceId });
                    this._broadcast('init_error', { device_id: targetDeviceId, message: String(err?.message || err || 'Initialization failed') });
                    query('UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?', ['disconnected', targetDeviceId]).catch(() => {});
                }
                throw err;
            }
        })();
        this._initPromises.set(targetDeviceId, initPromise);
        try {
            return await initPromise;
        } finally {
            if (this._initPromises.get(targetDeviceId) === initPromise) {
                this._initPromises.delete(targetDeviceId);
            }
        }
    }

    _createPairingWaiter(deviceId, timeoutMs = 30000) {
        const existing = this._pendingPairingResolvers.get(deviceId);
        if (existing?.timer) clearTimeout(existing.timer);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pendingPairingResolvers.delete(deviceId);
                reject(new Error('Timed out while waiting for pairing code'));
            }, timeoutMs);
            this._pendingPairingResolvers.set(deviceId, { resolve, reject, timer });
        });
    }

    _resolvePairingWaiter(deviceId, pairingCode) {
        const pending = this._pendingPairingResolvers.get(deviceId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this._pendingPairingResolvers.delete(deviceId);
        pending.resolve(pairingCode);
    }

    _rejectPairingWaiter(deviceId, error) {
        const pending = this._pendingPairingResolvers.get(deviceId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this._pendingPairingResolvers.delete(deviceId);
        pending.reject(error instanceof Error ? error : new Error(String(error || 'Pairing code request failed')));
    }

    async _waitForPairingCodeSupport(deviceId, timeoutMs = 15000) {
        const startedAt = Date.now();
        let lastError = null;
        console.log(`[WA][PAIRING] Waiting for pairing code support for ${deviceId} (timeout: ${timeoutMs}ms)`);
        while ((Date.now() - startedAt) < timeoutMs) {
            const ds = this._devState(deviceId);
            if (ds.client) {
                console.log(`[WA][PAIRING] Client ready for ${deviceId} after ${Date.now() - startedAt}ms`);
                return ds.client;
            }
            if (ds.status === 'disconnected') {
                lastError = new Error('WhatsApp client disconnected while waiting for pairing code support');
                console.error(`[WA][PAIRING] Client disconnected for ${deviceId}`);
            }
            await new Promise(resolve => setTimeout(resolve, 100)); // Faster polling: 100ms instead of 500ms
        }
        if (lastError) throw lastError;
        throw new Error('Timed out while waiting for WhatsApp pairing code support');
    }

    async _promoteReadyIfConnected(client, deviceId, source = 'fallback') {
        if (!this._isActiveClient(client, deviceId)) return false;
        const ds = this._devState(deviceId);
        if (ds.status === 'ready') return true;

        let state = '';
        try {
            state = await client.getState();
        } catch {}

        const info = client.info || ds.info || null;
        const isConnected = String(state || '').toUpperCase() === 'CONNECTED';
        const hasIdentity = !!info?.wid?.user;
        if (!isConnected && !hasIdentity) return false;

        ds.status = 'ready';
        ds._connectingSince = null;
        ds.qrCode = null;
        ds.qrBase64 = null;
        ds.info = info;

        console.log(`[WA] Ready (via ${source}) for ${deviceId}${ds.info?.wid?.user ? ` as ${ds.info.wid.user}` : ''}`);
        this._broadcast('status', { status: 'ready', info: this._sanitizeInfo(ds.info), device_id: deviceId });
        this._broadcast('ready', { info: this._sanitizeInfo(ds.info), device_id: deviceId });
        webhookService.dispatch('connected', { info: this._sanitizeInfo(ds.info) }, deviceId);
        query(
            'UPDATE devices SET status = ?, phone = ?, pushname = ?, platform = ?, updated_at = NOW() WHERE device_id = ?',
            ['ready', ds.info?.wid?.user || null, ds.info?.pushname || null, ds.info?.platform || null, deviceId]
        ).catch(() => {});
        return true;
    }

    _registerEvents(client, deviceId) {
        client.on('qr', async (qr) => {
            if (!this._isActiveClient(client, deviceId)) return;
            const ds = this._devState(deviceId);
            ds.status = 'qr';
            ds.qrCode = qr;
            try {
                ds.qrBase64 = await qrcode.toDataURL(qr);
            } catch { ds.qrBase64 = null; }
            this._broadcast('qr', { qr, qrBase64: ds.qrBase64, device_id: deviceId });
            console.log('[WA] QR Code generated - scan to connect');
            query('UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?', ['qr', deviceId]).catch(() => {});
        });

        client.on('authenticated', () => {
            if (!this._isActiveClient(client, deviceId)) return;
            console.log('[WA] Authenticated');
            this._broadcast('authenticated', { device_id: deviceId });
            this._promoteReadyIfConnected(client, deviceId, 'authenticated_event').catch(() => {});
        });

        client.on('code', (pairingCode) => {
            if (!this._isActiveClient(client, deviceId)) return;
            const normalizedCode = String(pairingCode || '').trim();
            if (!normalizedCode) return;
            console.log(`[WA][PAIRING] Pairing code received for ${deviceId}: ${normalizedCode}`);
            this._broadcast('pairing_code', { device_id: deviceId, pairingCode: normalizedCode });
            this._resolvePairingWaiter(deviceId, normalizedCode);
        });

        client.on('auth_failure', (msg) => {
            if (!this._isActiveClient(client, deviceId)) return;
            console.error('[WA] Auth failure:', msg);
            const ds = this._devState(deviceId);
            ds.status = 'disconnected';
            ds.client = null;
            ds.qrCode = null;
            ds.qrBase64 = null;
            ds.info = null;
            this._rejectPairingWaiter(deviceId, new Error(String(msg || 'Authentication failure')));
            this._broadcast('auth_failure', { message: msg, device_id: deviceId });
            query('UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?', ['disconnected', deviceId]).catch(() => {});
            this._scheduleReconnect(deviceId, 'auth_failure').catch(() => {});
        });

        client.on('ready', async () => {
            if (!this._isActiveClient(client, deviceId)) return;
            await this._promoteReadyIfConnected(client, deviceId, 'ready_event');
            // reset reconnect attempts on ready
            const st = this._getReconnectState(deviceId);
            st.attempts = 0;
        });

        client.on('disconnected', async (reason) => {
            if (!this._isActiveClient(client, deviceId)) return;
            const reasonStr = String(reason || '').toLowerCase();
            // detached_frame can be a false positive — verify browser is still alive before destroying
            if (reasonStr.includes('detached_frame') || reasonStr.includes('detached frame')) {
                try {
                    const browserAlive = client.pupBrowser?.isConnected?.() ?? false;
                    const pageClosed = client.pupPage?.isClosed?.() ?? true;
                    if (browserAlive && !pageClosed) {
                        console.log(`[WA] Disconnected event with detached_frame but browser still alive — ignoring false positive for ${deviceId}`);
                        const ds = this._devState(deviceId);
                        if (ds.status !== 'ready') {
                            ds.status = 'ready';
                            this._broadcast('status', { status: 'ready', device_id: deviceId });
                            query('UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?', ['ready', deviceId]).catch(() => {});
                        }
                        return;
                    }
                } catch {}
            }
            console.log('[WA] Disconnected:', reason);
            const ds = this._devState(deviceId);
            ds.status = 'disconnected';
            ds.client = null;
            ds.qrCode = null;
            ds.qrBase64 = null;
            ds.info = null;
            this._rejectPairingWaiter(deviceId, new Error(`Disconnected: ${reason || 'unknown'}`));
            this._broadcast('disconnected', { reason, device_id: deviceId });
            webhookService.dispatch('disconnected', { reason }, deviceId);
            query('UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?', ['disconnected', deviceId]).catch(() => {});
            this._scheduleReconnect(deviceId, `disconnected:${reason || 'unknown'}`).catch(() => {});
        });

        client.on('message', async (msg) => {
            if (!this._isActiveClient(client, deviceId)) return;
            await this._handleIncomingMessage(msg, deviceId, client);
        });

        client.on('message_create', async (msg) => {
            if (!this._isActiveClient(client, deviceId)) return;
            if (msg.fromMe) {
                await this._handleOutgoingMessage(msg, deviceId, client);
            }
        });

        client.on('message_revoke_everyone', async (after, before) => {
            if (!this._isActiveClient(client, deviceId)) return;
            const target = before || after;
            await this._handleMessageRevoked(target, 'MESSAGE_REVOKED_EVERYONE', deviceId);
        });

        client.on('message_revoke_me', async (msg) => {
            if (!this._isActiveClient(client, deviceId)) return;
            await this._handleMessageRevoked(msg, 'MESSAGE_REVOKED_ME', deviceId);
        });

        client.on('message_ack', (msg, ack) => {
            if (!this._isActiveClient(client, deviceId)) return;
            const ackMap = { 0: 'pending', 1: 'sent', 2: 'delivered', 3: 'read', 4: 'played' };
            this._broadcast('message_ack', {
                id: msg.id?.id,
                to: msg.to,
                ack: ack,
                ackLabel: ackMap[ack] || 'unknown',
            });
        });

        client.on('typing', (chat) => {
            if (!this._isActiveClient(client, deviceId)) return;
            this._broadcast('typing', { chatId: chat.id?._serialized, name: chat.name });
            if (config.features?.autoRejectTyping) {
                this._handleAutoRejectTyping(chat);
            }
        });

        client.on('stop_typing', (chat) => {
            if (!this._isActiveClient(client, deviceId)) return;
            this._broadcast('stop_typing', { chatId: chat.id?._serialized });
            if (this._typingTimers.has(chat.id?._serialized)) {
                clearTimeout(this._typingTimers.get(chat.id?._serialized));
                this._typingTimers.delete(chat.id?._serialized);
            }
        });

        client.on('group_join', (notification) => {
            if (!this._isActiveClient(client, deviceId)) return;
            this._broadcast('group_join', { chatId: notification.chatId, author: notification.author });
            webhookService.dispatch('group_join', { chatId: notification.chatId, author: notification.author }, deviceId);
        });

        client.on('group_leave', (notification) => {
            if (!this._isActiveClient(client, deviceId)) return;
            this._broadcast('group_leave', { chatId: notification.chatId, author: notification.author });
            webhookService.dispatch('group_leave', { chatId: notification.chatId, author: notification.author }, deviceId);
        });

        client.on('change_state', (state) => {
            if (!this._isActiveClient(client, deviceId)) return;
            console.log('[WA] State changed:', state);
            this._broadcast('change_state', { state, device_id: deviceId });
            if (String(state || '').toUpperCase() === 'CONNECTED') {
                this._promoteReadyIfConnected(client, deviceId, 'change_state_connected').catch(() => {});
            }
        });
    }

    _handleAutoRejectTyping(chat) {
        const chatId = chat.id?._serialized;
        if (!chatId) return;
        if (this._typingTimers.has(chatId)) {
            clearTimeout(this._typingTimers.get(chatId));
        }
        const timer = setTimeout(async () => {
            try {
                const c = await (this.client?.getChatById(chatId));
                if (c) await c.clearState();
            } catch { /* ignore */ }
            this._typingTimers.delete(chatId);
        }, 3000);
        this._typingTimers.set(chatId, timer);
    }

    async _isIncomingAckReplyEnabled(deviceId) {
        const devId = deviceId || this.currentDeviceId;
        const ds = this._devState(devId);
        try {
            const row = await queryOne('SELECT incoming_ack_reply_enabled FROM devices WHERE device_id = ? LIMIT 1', [devId]);
            const enabled = !!row?.incoming_ack_reply_enabled;
            ds.incomingAckReplyEnabled = enabled;
            return enabled;
        } catch {
            return !!ds.incomingAckReplyEnabled;
        }
    }

    _extractWebhookReplyText(dispatchResults = []) {
        const settled = Array.isArray(dispatchResults) ? dispatchResults : [];
        for (const item of settled) {
            const result = item?.status === 'fulfilled' ? item.value : item;
            if (!result?.success) continue;
            const body = result?.data;
            if (!body || typeof body !== 'object') continue;
            const candidates = [
                body.reply,
                body.message,
                body.text,
                body.data?.reply,
                body.data?.message,
                body.data?.text,
                body.response?.reply,
                body.response?.message,
                body.response?.text,
            ];
            const replyText = candidates.find(value => typeof value === 'string' && value.trim());
            if (replyText) return replyText.trim();
        }
        return '';
    }

    _buildIncomingDedupKey(msg, deviceId) {
        const rawId = msg?.id?.id
            || msg?.id?._serialized
            || msg?._data?.id?.id
            || msg?._data?.id?._serialized
            || '';
        if (rawId) return `${deviceId}:${rawId}`;
        const from = String(msg?.from || '').trim();
        const body = String(msg?.body || '').trim();
        const ts = Number(msg?.timestamp || msg?._data?.t || 0);
        if (!from || !body || !ts) return '';
        return `${deviceId}:fallback:${from}:${body}:${ts}`;
    }

    _buildIncomingContentKey(msg, deviceId) {
        const from = String(msg?.from || '').trim();
        const author = String(msg?.author || '').trim();
        const type = String(msg?.type || '').trim();
        const body = String(msg?.body || '').trim();
        if (!from || !body) return '';
        return `${deviceId}:content:${from}:${author}:${type}:${body}`;
    }

    _trackSentMsgId(msgId, ttlMs = 5 * 60 * 1000) {
        if (!msgId) return;
        const now = Date.now();
        this._sentMsgIds.set(msgId, now + ttlMs);
        if (this._sentMsgIds.size > 2000) {
            for (const [k, exp] of this._sentMsgIds) {
                if (exp <= now) this._sentMsgIds.delete(k);
            }
            while (this._sentMsgIds.size > 2000) {
                const first = this._sentMsgIds.keys().next().value;
                if (!first) break;
                this._sentMsgIds.delete(first);
            }
        }
    }

    _isSentMsgId(msgId) {
        if (!msgId) return false;
        const exp = this._sentMsgIds.get(msgId);
        if (!exp) return false;
        if (exp <= Date.now()) {
            this._sentMsgIds.delete(msgId);
            return false;
        }
        return true;
    }

    _markIncomingProcessed(dedupKey, ttlMs = 5 * 60 * 1000) {
        if (!dedupKey) return;
        const now = Date.now();
        this._processedIncomingMsgIds.set(dedupKey, now + ttlMs);
        if (this._processedIncomingMsgIds.size > 5000) {
            for (const [key, expiresAt] of this._processedIncomingMsgIds) {
                if (expiresAt <= now) this._processedIncomingMsgIds.delete(key);
            }
            while (this._processedIncomingMsgIds.size > 5000) {
                const firstKey = this._processedIncomingMsgIds.keys().next().value;
                if (!firstKey) break;
                this._processedIncomingMsgIds.delete(firstKey);
            }
        }
    }

    async _showTypingIndicatorDuringDelay(chat, waitMs) {
        const duration = Number(waitMs || 0);
        if (!chat || !Number.isFinite(duration) || duration <= 0) return;
        let interval = null;
        try {
            await chat.sendStateTyping().catch(() => {});
            interval = setInterval(() => {
                chat.sendStateTyping().catch(() => {});
            }, 4000);
            await new Promise(resolve => setTimeout(resolve, duration));
        } finally {
            if (interval) clearInterval(interval);
            await chat.clearState().catch(() => {});
        }
    }

    _resolveWebhookMessageDelayMs() {
        const opts = Array.isArray(config.webhook?.messageDelayOptionsMs)
            ? config.webhook.messageDelayOptionsMs.filter(v => Number.isFinite(v) && v >= 0)
            : [];
        if (opts.length > 0) {
            const idx = Math.floor(Math.random() * opts.length);
            return opts[idx] || 0;
        }
        const fixed = Number(config.webhook?.messageDelayMs || 0);
        return Number.isFinite(fixed) && fixed > 0 ? fixed : 0;
    }

    _markTimedKey(map, key, ttlMs = 5 * 60 * 1000, maxSize = 5000) {
        if (!key) return;
        const now = Date.now();
        map.set(key, now + ttlMs);
        if (map.size > maxSize) {
            for (const [k, expiresAt] of map) {
                if (expiresAt <= now) map.delete(k);
            }
            while (map.size > maxSize) {
                const firstKey = map.keys().next().value;
                if (!firstKey) break;
                map.delete(firstKey);
            }
        }
    }

    _isTimedKeyDuplicate(map, key) {
        if (!key) return false;
        const expiresAt = map.get(key);
        if (!expiresAt) return false;
        if (expiresAt <= Date.now()) {
            map.delete(key);
            return false;
        }
        return true;
    }

    // ── Nuclear outgoing send dedup ────────────────────────────────────────────
    _buildOutgoingSendKey(deviceId, recipient, body) {
        const r = String(recipient || '').replace(/@.+$/, '').replace(/\D/g, '');
        const b = String(body || '').trim();
        if (!r || !b) return '';
        const hash = crypto.createHash('md5').update(b).digest('hex');
        return `${deviceId}:out:${r}:${hash}`;
    }

    _isOutgoingSendDuplicate(deviceId, recipient, body, ttlMs = 2000) {
        const key = this._buildOutgoingSendKey(deviceId, recipient, body);
        if (!key) return false;
        const now = Date.now();
        const expiresAt = this._outgoingSendDedup.get(key);
        if (expiresAt && expiresAt > now) {
            console.log(`[WA][DEDUP] Blocked duplicate outgoing send to ${recipient} on device ${deviceId}`);
            return true;
        }
        this._outgoingSendDedup.set(key, now + ttlMs);
        // housekeep
        if (this._outgoingSendDedup.size > 5000) {
            for (const [k, exp] of this._outgoingSendDedup) {
                if (exp <= now) this._outgoingSendDedup.delete(k);
            }
        }
        return false;
    }

    // Check if ANY message was recently sent to the same recipient (ignoring body text).
    // Used to prevent webhook auto-reply when the callback already called /api/send.
    _hasRecentSendToRecipient(deviceId, recipient, windowMs = 30000) {
        const r = String(recipient || '').replace(/@.+$/, '').replace(/\D/g, '');
        if (!r) return false;
        const prefix = `${deviceId}:out:${r}:`;
        const now = Date.now();
        for (const [key, expiresAt] of this._outgoingSendDedup) {
            if (key.startsWith(prefix) && expiresAt > now) return true;
        }
        return false;
    }

    _isIncomingDuplicate(dedupKey) {
        if (!dedupKey) return false;
        const expiresAt = this._processedIncomingMsgIds.get(dedupKey);
        if (!expiresAt) return false;
        if (expiresAt <= Date.now()) {
            this._processedIncomingMsgIds.delete(dedupKey);
            return false;
        }
        return true;
    }

    _getSessionFolders(deviceId) {
        const devId = String(deviceId || '').trim();
        if (!devId) return [];
        return [
            path.resolve(config.session.path, `session-${devId}`),
            path.resolve(config.session.path, '.wwebjs_auth', `session-${devId}`),
        ];
    }

    async _purgeSessionFolders(deviceId, { strict = false, retries = 8 } = {}) {
        const dirs = this._getSessionFolders(deviceId);
        const removed = [];
        const failed = [];
        for (const dir of dirs) {
            if (!dir) continue;
            let deleted = false;
            let lastError = null;
            for (let attempt = 1; attempt <= retries; attempt++) {
                try {
                    if (fs.existsSync(dir)) {
                        this._recursiveRmForce(dir);
                    }
                    if (!fs.existsSync(dir)) {
                        deleted = true;
                        removed.push(dir);
                        break;
                    }
                } catch (err) {
                    lastError = err;
                }
                await this._wait(300 * attempt);
            }
            if (!deleted) {
                failed.push({ dir, error: lastError?.message || 'Directory still exists after purge attempts' });
            }
        }
        if (strict && failed.length) {
            const details = failed.map(item => `${item.dir} (${item.error})`).join('; ');
            console.warn(`[WA] Failed to purge some folders: ${details} (proceeding anyway since strict might be too harsh)`);
        }
        return { removed, failed };
    }

    _recursiveRmForce(dirPath) {
        if (!fs.existsSync(dirPath)) return;
        const stat = fs.statSync(dirPath);
        if (stat.isDirectory()) {
            const entries = fs.readdirSync(dirPath);
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry);
                try {
                    this._recursiveRmForce(fullPath);
                } catch {}
            }
        }
        try {
            fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 5 });
        } catch {}
    }

    _clearDeviceScopedCaches(deviceId) {
        const devPrefix = `${deviceId}:`;
        this._pendingPairingResolvers.delete(deviceId);
        for (const key of this._inflightIncomingKeys.values()) {
            if (String(key || '').startsWith(devPrefix)) {
                this._inflightIncomingKeys.delete(key);
            }
        }
        for (const key of this._processedIncomingMsgIds.keys()) {
            if (String(key || '').startsWith(devPrefix)) {
                this._processedIncomingMsgIds.delete(key);
            }
        }
        for (const key of this._processedIncomingContentKeys.keys()) {
            if (String(key || '').startsWith(devPrefix)) {
                this._processedIncomingContentKeys.delete(key);
            }
        }
        for (const key of this._processedWebhookDispatchKeys.keys()) {
            if (String(key || '').startsWith(devPrefix)) {
                this._processedWebhookDispatchKeys.delete(key);
            }
        }
        for (const key of this._sentWebhookReplyKeys.keys()) {
            if (String(key || '').startsWith(devPrefix)) {
                this._sentWebhookReplyKeys.delete(key);
            }
        }
        for (const key of this._outgoingSendDedup.keys()) {
            if (String(key || '').startsWith(devPrefix)) {
                this._outgoingSendDedup.delete(key);
            }
        }
    }

    async _handleIncomingMessage(msg, deviceId = null, client = null) {
        if (msg.fromMe) return;
        const devId = deviceId || this.currentDeviceId;
        const cl = client || this.client;

        // Only persist/display real chat messages (ignore system/status noise)
        if (_IGNORED_LOG_TYPES.has(String(msg.type || ''))) {
            return;
        }
        const incomingDedupKey = this._buildIncomingDedupKey(msg, devId);
        const incomingContentKey = this._buildIncomingContentKey(msg, devId);
        if (this._isIncomingDuplicate(incomingDedupKey)) {
            return;
        }
        if (this._isTimedKeyDuplicate(this._processedIncomingContentKeys, incomingContentKey)) {
            return;
        }
        const processKey = incomingDedupKey || incomingContentKey;
        if (processKey && this._inflightIncomingKeys.has(processKey)) {
            return;
        }
        if (processKey) this._inflightIncomingKeys.add(processKey);
        this._markIncomingProcessed(incomingDedupKey);
        this._markTimedKey(this._processedIncomingContentKeys, incomingContentKey, 2 * 1000, 20000);

        try {

            const chat = await msg.getChat().catch(() => null);
            const contact = await msg.getContact().catch(() => null);
            let downloadedMedia = null;

        if (config.features?.autoReadMessages && chat) {
            await chat.sendSeen().catch(() => {});
        }

        // Resolve sender number the way whatsapp-web.js exposes it: prefer contact.number
        // and author/original numeric sender over raw JID, with a safe fallback.
        let fromNum = '';
        const numericCandidates = [
            contact?.number || '',
            String(msg.author || '').split('@')[0],
            String(msg.from || '').split('@')[0],
        ].map(v => String(v || '').replace(/\D/g, '')).filter(Boolean);

        const preferredNumeric = numericCandidates.find(v => v.length >= 8 && v.length <= 15) || '';
        if (preferredNumeric) {
            fromNum = `${preferredNumeric}@c.us`;
        } else {
            fromNum = msg.from; // fallback: raw JID
            const msgFromUser = (msg.from || '').split('@')[0];
            const isLidLike = msg.from?.endsWith('@lid') || msgFromUser.replace(/\D/g, '').length >= 15;

            if (isLidLike) {
                const lidUser = msgFromUser;
                try {
                    const resolved = await cl.getContactById(`${lidUser}@c.us`).catch(() => null);
                    if (resolved?.number) {
                        fromNum = `${resolved.number}@c.us`;
                    }
                } catch {}
                const resolvedUser = (fromNum || '').split('@')[0].replace(/\D/g, '');
                if (resolvedUser.length >= 15 || fromNum?.endsWith('@lid')) {
                    fromNum = `${lidUser}@c.us`;
                }
            }
        }

            if (msg.hasMedia) {
                downloadedMedia = await msg.downloadMedia().catch(() => null);
            }

            const logFrom = this._normalizeLogNumber(fromNum || msg.from, { isGroup: msg.from?.includes('@g.us') });
            const logTo = this._normalizeLogNumber(msg.to, { isGroup: msg.to?.includes('@g.us') });

            // Skip anything that cannot be normalized (prevents LID & junk from entering /messages)
            if (!logFrom) {
                return;
            }

            const payload = {
            id: msg.id?.id,
            device_id: devId,
            from: fromNum || msg.from,
            from_num: logFrom,
            to: msg.to,
            to_num: logTo || msg.to,
            body: msg.body,
            type: msg.type,
            isGroup: msg.from?.includes('@g.us'),
            hasMedia: msg.hasMedia,
            mime_type: downloadedMedia?.mimetype || null,
            file_name: downloadedMedia?.filename || null,
            media_data: downloadedMedia ? `data:${downloadedMedia.mimetype};base64,${downloadedMedia.data}` : null,
            timestamp: msg.timestamp,
            author: msg.author || null,
            contact: contact ? {
                name: contact.pushname || contact.name,
                number: contact.number,
                isMyContact: contact.isMyContact,
            } : null,
            chat: chat ? { name: chat.name, id: chat.id?._serialized } : null,
        };

            try {
                await this._insertMessageLog({
                    deviceId: devId,
                    direction: 'in',
                    fromNum: logFrom,
                    toNum: logTo || null,
                    body: msg.body || null,
                    type: msg.type,
                    isGroup: msg.from?.includes('@g.us') ? 1 : 0,
                    msgId: msg.id?.id || null,
                    mimeType: downloadedMedia?.mimetype || null,
                    fileName: downloadedMedia?.filename || null,
                    mediaData: downloadedMedia ? `data:${downloadedMedia.mimetype};base64,${downloadedMedia.data}` : null,
                    isRead: 0,
                });
            } catch (e) {
                console.error('[WA] Failed to save incoming msg:', e.message);
            }

            payload.is_read = 0;
            this._broadcast('message', payload);

            // Incoming Ack Reply: reply (quote) the incoming message before webhook processing
            const ackEnabled = await this._isIncomingAckReplyEnabled(devId);
            if (ackEnabled && !msg.from?.includes('@g.us')) {
                const ackText = String(config.features?.incomingAckReplyText || '').trim() || 'Pesan diterima ...';
                try {
                    const ackReply = await msg.reply(ackText);
                    if (ackReply?.id?.id) this._trackSentMsgId(ackReply.id.id);
                    await this._insertMessageLog({
                        deviceId: devId, direction: 'out', fromNum: null, toNum: logFrom,
                        body: ackText, type: 'chat', isGroup: 0,
                        msgId: ackReply?.id?.id || null, isRead: 1,
                    }).catch(() => {});
                    console.log(`[WA] Ack reply (quoted) sent to ${logFrom || msg.from} on device ${devId}`);
                } catch (e) {
                    if (this._isDetachedFrameError(e)) {
                        await this._markClientNeedsReconnect(devId, 'detached_frame_ack_reply');
                        return;
                    }
                    console.warn(`[WA] Failed to send ack reply: ${e.message}`);
                }
            } else if (ackEnabled && msg.from?.includes('@g.us') && config.features?.incomingAckReplyOnGroups) {
                const ackText = String(config.features?.incomingAckReplyText || '').trim() || 'Pesan diterima ...';
                try {
                    const ackReply = await msg.reply(ackText);
                    if (ackReply?.id?.id) this._trackSentMsgId(ackReply.id.id);
                    await this._insertMessageLog({
                        deviceId: devId, direction: 'out', fromNum: null, toNum: logFrom,
                        body: ackText, type: 'chat', isGroup: 1,
                        msgId: ackReply?.id?.id || null, isRead: 1,
                    }).catch(() => {});
                } catch (e) {
                    console.warn(`[WA] Failed to send group ack reply: ${e.message}`);
                }
            }

            const webhookDispatchKey = `${devId}:${payload.id || incomingDedupKey || incomingContentKey || `${payload.from}:${payload.timestamp}`}`;
            if (this._isTimedKeyDuplicate(this._processedWebhookDispatchKeys, webhookDispatchKey)) {
                return;
            }
            this._markTimedKey(this._processedWebhookDispatchKeys, webhookDispatchKey, 2 * 1000, 10000);
            const webhookDelayMs = this._resolveWebhookMessageDelayMs();
            if (webhookDelayMs > 0) {
                await this._showTypingIndicatorDuringDelay(chat, webhookDelayMs);
            }
            const webhookResults = await webhookService.dispatch('message', payload, devId);
            const webhookReplyText = this._extractWebhookReplyText(webhookResults);
            if (webhookReplyText) {
                // Note: Callback server no longer calls /api/send directly, it only returns reply text.
                // WA Gateway auto-reply is now the single source for sending replies.
                // _hasRecentSendToRecipient check removed as there's no longer a duplicate source.
                const webhookReplyKey = `${webhookDispatchKey}:reply:${webhookReplyText}`;
                if (this._isTimedKeyDuplicate(this._sentWebhookReplyKeys, webhookReplyKey)) {
                    return;
                }
                this._markTimedKey(this._sentWebhookReplyKeys, webhookReplyKey, 2 * 1000, 10000);
                if (this._isOutgoingSendDuplicate(devId, msg.from, webhookReplyText)) {
                    return;
                }
                // Per-device reply delay with typing indicator
                const replyDelayMs = (this._devState(devId)?.webhookReplyDelay || 0) * 1000;
                if (replyDelayMs > 0 && chat) {
                    await this._showTypingIndicatorDuringDelay(chat, replyDelayMs);
                }
                try {
                    const webhookReply = await cl.sendMessage(msg.from, webhookReplyText);
                    if (webhookReply?.id?.id) this._trackSentMsgId(webhookReply.id.id);
                    await this._insertMessageLog({
                        deviceId: devId, direction: 'out', fromNum: null, toNum: logFrom,
                        body: webhookReplyText, type: 'chat',
                        isGroup: msg.from?.includes('@g.us') ? 1 : 0,
                        msgId: webhookReply?.id?.id || null, isRead: 1,
                    }).catch(() => {});
                    console.log(`[WA] Webhook reply sent to ${payload.from_num || msg.from} on device ${devId}`);
                } catch (e) {
                    if (this._isDetachedFrameError(e)) {
                        await this._markClientNeedsReconnect(devId, 'detached_frame_webhook_reply');
                    }
                    console.warn(`[WA] Failed to send webhook reply to ${payload.from_num || msg.from} on device ${devId}: ${e.message}`);
                }
                return;
            }

            const hasAnyWebhookSuccess = Array.isArray(webhookResults)
                ? webhookResults.some(item => {
                    const result = item?.status === 'fulfilled' ? item.value : item;
                    return !!result?.success;
                })
                : false;
            const fallbackReplyText = hasAnyWebhookSuccess
                ? ''
                : 'Maaf, sistem sedang gangguan. Silakan coba lagi sebentar.';
            if (fallbackReplyText) {
                if (!this._isOutgoingSendDuplicate(devId, msg.from, fallbackReplyText)) {
                    try {
                        const webhookReply = await cl.sendMessage(msg.from, fallbackReplyText);
                        if (webhookReply?.id?.id) this._trackSentMsgId(webhookReply.id.id);
                        await this._insertMessageLog({
                            deviceId: devId, direction: 'out', fromNum: null, toNum: logFrom,
                            body: fallbackReplyText, type: 'chat',
                            isGroup: msg.from?.includes('@g.us') ? 1 : 0,
                            msgId: webhookReply?.id?.id || null, isRead: 1,
                        }).catch(() => {});
                    } catch (e) {
                        console.warn(`[WA] Failed to send fallback reply to ${payload.from_num || msg.from} on device ${devId}: ${e.message}`);
                    }
                }
            }
        } finally {
            if (processKey) this._inflightIncomingKeys.delete(processKey);
        }
    }

    async _handleOutgoingMessage(msg, deviceId = null, client = null) {
        const devId = deviceId || this.currentDeviceId;
        const cl = client || this.client;
        const msgId = msg.id?.id || null;

        // Skip if already saved by sendText/sendMedia/sendSticker (API-originated)
        if (msgId && this._isSentMsgId(msgId)) {
            this._sentMsgIds.delete(msgId);
            return;
        }

        // Extra dedup: skip if this msg_id is already in DB (race between API save and event)
        if (msgId) {
            const exists = await queryOne(
                'SELECT id FROM message_logs WHERE device_id = ? AND msg_id = ? LIMIT 1',
                [devId, msgId]
            ).catch(() => null);
            if (exists?.id) return;
        }

        // Phone-originated outgoing message — single pass: resolve, log, broadcast
        const recipient = await this._resolveOutgoingRecipient(msg.to, cl);
        const logTo = this._normalizeLogNumber(recipient.raw || recipient.jid || msg.to, { isGroup: msg.to?.includes('@g.us') });
        if (!logTo) return;

        const downloadedMedia = msg.hasMedia ? await msg.downloadMedia().catch(() => null) : null;

        try {
            await this._insertMessageLog({
                deviceId: devId,
                direction: 'out',
                fromNum: null,
                toNum: logTo,
                body: msg.body || null,
                type: msg.type,
                isGroup: msg.to?.includes('@g.us') ? 1 : 0,
                msgId,
                mimeType: downloadedMedia?.mimetype || null,
                fileName: downloadedMedia?.filename || null,
                mediaData: downloadedMedia ? `data:${downloadedMedia.mimetype};base64,${downloadedMedia.data}` : null,
                isRead: 1,
            });
        } catch (e) {
            console.error('[WA] Failed to save outgoing msg_create:', e.message);
        }

        const payload = {
            id: msgId,
            device_id: devId,
            to: recipient.jid || msg.to,
            to_num: logTo,
            body: msg.body,
            type: msg.type,
            hasMedia: msg.hasMedia,
            mime_type: downloadedMedia?.mimetype || null,
            file_name: downloadedMedia?.filename || null,
            media_data: downloadedMedia ? `data:${downloadedMedia.mimetype};base64,${downloadedMedia.data}` : null,
            is_read: 1,
            timestamp: msg.timestamp,
        };
        this._broadcast('message_sent', payload);
        webhookService.dispatch('message_sent', payload, devId);
    }

    async _handleMessageRevoked(msg, mode, deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        const msgId = msg?.id?.id || msg?.id?._serialized || null;
        if (!msgId) return;
        try {
            await query('DELETE FROM message_logs WHERE device_id = ? AND msg_id = ?', [devId, msgId]);
        } catch (e) {
            console.error('[WA] Failed to delete revoked msg log:', e.message);
        }
        const payload = {
            device_id: devId,
            messageId: msgId,
            chatId: msg?.from || msg?.to || null,
            mode,
        };
        this._broadcast('message_revoked', payload);
        webhookService.dispatch('message_revoked', payload, devId);
    }

    _sanitizeInfo(info) {
        if (!info) return null;
        return {
            wid: info.wid,
            pushname: info.pushname,
            number: info.wid?.user,
            platform: info.platform,
        };
    }

    async _insertMessageLog(entry) {
        const {
            deviceId,
            direction,
            fromNum = null,
            toNum = null,
            body = null,
            type = 'chat',
            isGroup = 0,
            msgId = null,
            mimeType = null,
            fileName = null,
            mediaData = null,
            isRead = 0,
        } = entry || {};

        if (msgId) {
            const exists = await queryOne(
                'SELECT id FROM message_logs WHERE device_id = ? AND msg_id = ? LIMIT 1',
                [deviceId, msgId]
            );
            if (exists?.id) return false;
        }

        await query(
            'INSERT INTO message_logs (device_id, direction, from_num, to_num, body, type, is_group, msg_id, mime_type, file_name, media_data, is_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [deviceId, direction, fromNum, toNum, body, type, isGroup, msgId, mimeType, fileName, mediaData, isRead]
        );
        return true;
    }

    async _resolveOutgoingRecipient(chatId, client = null) {
        const cl = client || this.client;
        const fallback = String(chatId || '').trim();
        if (!fallback) return { jid: fallback, raw: fallback };
        if (!fallback.endsWith('@lid')) return { jid: fallback, raw: fallback };

        const lidUser = fallback.split('@')[0] || fallback;
        const candidates = [`${lidUser}@c.us`, fallback];

        for (const candidate of candidates) {
            try {
                const contact = await cl.getContactById(candidate).catch(() => null);
                if (contact?.number) {
                    return { jid: `${contact.number}@c.us`, raw: contact.number };
                }
                const serialized = contact?.id?._serialized ? String(contact.id._serialized) : '';
                if (serialized && !serialized.endsWith('@lid')) {
                    return { jid: serialized, raw: serialized.split('@')[0] || serialized };
                }
            } catch {}
        }

        return { jid: fallback, raw: lidUser };
    }

    async _findChatMessageById(client, chatId, messageId, fetchLimit = 300) {
        try {
            const chat = await client.getChatById(chatId);
            const msgs = await chat.fetchMessages({ limit: fetchLimit });
            const targetId = String(messageId);
            return msgs.find(m => m.id?.id === targetId || m.id?._serialized === targetId) || null;
        } catch {
            return null;
        }
    }

    async _ensureChatReady(client, chatId) {
        const jid = String(chatId || '').trim();
        if (!jid) return null;
        try {
            return await client.getChatById(jid);
        } catch {
            // Try resolving via contact first (some WA web states need contact hydration)
            try {
                await client.getContactById(jid).catch(() => null);
            } catch {}
            try {
                return await client.getChatById(jid);
            } catch {
                return null;
            }
        }
    }

    _isWwebGetChatUndefinedError(err) {
        const msg = String(err?.message || err || '');
        return msg.includes("reading 'getChat'") || (msg.includes('getChat') && msg.includes('undefined'));
    }

    _isDetachedFrameError(err) {
        const msg = String(err?.message || err || '');
        // Only truly fatal errors that indicate the browser page/session is gone
        return msg.includes('detached Frame') || msg.includes('Session closed') || msg.includes('Target closed');
    }

    _isTransientProtocolError(err) {
        const msg = String(err?.message || err || '');
        // Protocol errors that are often transient/retryable (not fatal)
        return msg.includes('Protocol error') && !msg.includes('Target closed') && !msg.includes('Session closed');
    }

    _isStaleSessionError(err) {
        const msg = String(err?.message || err || '');
        // "No LID for user" and similar errors indicate the WA session is zombie/stale
        return msg.includes('No LID for user') || msg.includes('not logged in') || msg.includes('wid is undefined');
    }

    _isDisconnectedWaState(state) {
        return [
            'CONFLICT',
            'DEPRECATED_VERSION',
            'DISCONNECTED',
            'LOGOUT',
            'PROXYBLOCK',
            'SMB_TOS_BLOCK',
            'TIMEOUT',
            'TOS_BLOCK',
            'UNPAIRED',
            'UNPAIRED_IDLE',
        ].includes(String(state || '').toUpperCase());
    }

    async _getClientConnectionSnapshot(client, deviceId = null) {
        const ds = deviceId ? this._devState(deviceId) : null;
        const snapshot = {
            state: '',
            hasInfo: false,
            browserConnected: null,
            pageClosed: null,
            connected: false,
            disconnected: false,
        };
        if (!client) {
            snapshot.disconnected = true;
            return snapshot;
        }

        snapshot.hasInfo = !!(client.info?.wid?.user || ds?.info?.wid?.user);

        try {
            snapshot.state = String(await client.getState() || '').toUpperCase();
        } catch {}

        if (snapshot.state === 'CONNECTED') snapshot.connected = true;
        if (this._isDisconnectedWaState(snapshot.state)) snapshot.disconnected = true;

        try {
            if (typeof client.pupBrowser?.isConnected === 'function') {
                snapshot.browserConnected = client.pupBrowser.isConnected();
            } else if (typeof client.pupBrowser?.connected === 'boolean') {
                snapshot.browserConnected = client.pupBrowser.connected;
            }
        } catch {}

        try {
            if (typeof client.pupPage?.isClosed === 'function') {
                snapshot.pageClosed = client.pupPage.isClosed();
            }
        } catch {}

        if (!snapshot.connected && snapshot.browserConnected === false) snapshot.disconnected = true;
        if (!snapshot.connected && snapshot.pageClosed === true) snapshot.disconnected = true;

        // Determine final connected state:
        // 1. getState() === 'CONNECTED' → definitely connected
        // 2. getState() returned a known disconnected state → definitely disconnected
        // 3. getState() returned empty/unknown BUT browser alive + has identity + internal status is 'ready'
        //    → trust the internal state (getState() can be unreliable/slow after reconnect)
        // 4. getState() returned empty/unknown, no identity or browser dead → stale
        if (snapshot.connected) {
            // Already confirmed via getState() === 'CONNECTED'
        } else if (snapshot.disconnected) {
            // Already confirmed disconnected
        } else if (snapshot.hasInfo && snapshot.browserConnected === true && snapshot.pageClosed === false && ds?.status === 'ready') {
            // Internal state says ready, browser alive, page open, has identity — trust it
            snapshot.connected = true;
        } else if (snapshot.browserConnected === true && snapshot.pageClosed === false && !snapshot.hasInfo) {
            // Browser alive, page open, but no identity and getState() not CONNECTED → stale
            snapshot.stale = true;
        } else if (snapshot.hasInfo && snapshot.browserConnected === true && ds?.status === 'ready') {
            // Has identity, browser alive, status ready, but couldn't confirm page state — trust it
            snapshot.connected = true;
        } else {
            // Ambiguous — mark stale
            snapshot.stale = true;
        }

        return snapshot;
    }

    async _isClientStillConnected(client, deviceId = null) {
        const snapshot = await this._getClientConnectionSnapshot(client, deviceId);
        return snapshot.connected;
    }

    async _markClientNeedsReconnect(deviceId, reason) {
        const ds = this._devState(deviceId);
        if (!ds) return false;

        if (ds.client) {
            const snapshot = await this._getClientConnectionSnapshot(ds.client, deviceId);
            if (!snapshot.disconnected && !snapshot.stale) {
                if (snapshot.connected) {
                    if (ds.status !== 'ready') {
                        ds.status = 'ready';
                        ds.info = ds.info || ds.client?.info || null;
                        this._broadcast('status', { status: 'ready', info: this._sanitizeInfo(ds.info), device_id: deviceId });
                        query('UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?', ['ready', deviceId]).catch(() => {});
                    }
                }
                // Don't spam logs — only log once per reason change
                return false;
            }
            // If stale (browser alive but WA state unknown), force reconnect
            if (snapshot.stale) {
                console.warn(`[WA][RECONNECT] Client for ${deviceId} is stale — reconnecting (reason: ${reason})`);
            }
        }

        const staleClient = ds.client;
        ds.status = 'disconnected';
        ds.client = null;
        ds.qrCode = null;
        ds.qrBase64 = null;
        ds.info = null;
        console.error(`[WA][RECONNECT] Client marked for reconnect: ${reason}`);
        if (staleClient) {
            await staleClient.destroy().catch(() => {});
            await this._wait(1200);
        }
        this._scheduleReconnect(deviceId, reason).catch(() => {});
        return true;
    }

    /**
     * Force-reconnect: unconditionally destroy the current client and schedule reconnect.
     * Used when we detect a zombie session (e.g. "No LID for user" error).
     */
    async _forceReconnect(deviceId, reason = 'force') {
        const ds = this._devState(deviceId);
        if (!ds) return;
        const staleClient = ds.client;
        ds.status = 'disconnected';
        ds.client = null;
        ds.qrCode = null;
        ds.qrBase64 = null;
        ds.info = null;
        this._broadcast('status', { status: 'disconnected', device_id: deviceId });
        this._broadcast('disconnected', { reason, device_id: deviceId });
        query('UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?', ['disconnected', deviceId]).catch(() => {});
        console.error(`[WA][RECONNECT] Force reconnect for ${deviceId}: ${reason}`);
        if (staleClient) {
            await staleClient.destroy().catch(() => {});
            await this._wait(1500);
        }
        // Kill any lingering chrome processes for this session
        this._killSessionChrome(deviceId);
        this._cleanSessionLock(deviceId);
        await this._wait(500);
        // Reset reconnect attempts so it reconnects quickly
        const st = this._getReconnectState(deviceId);
        st.attempts = 0;
        st.suppressUntil = 0;
        this._cancelReconnect(deviceId, 'force_reconnect_reset');
        await this._scheduleReconnect(deviceId, reason).catch(() => {});
    }

    async _retrySendAfterDetachedFrame(deviceId, chatId, label, sendFn, reason = 'detached_frame') {
        const ds = this._devState(deviceId);

        // Detached frame is often transient — wait and retry without destroying the client
        console.warn(`[WA] ${label} hit detached_frame — waiting before retry`);
        await this._wait(1500);

        const liveDs = this._devState(deviceId);
        if (liveDs.client && liveDs.status === 'ready') {
            await this._ensureChatReady(liveDs.client, chatId).catch(() => {});
            try {
                return await sendFn(liveDs.client);
            } catch (retryErr) {
                if (this._isStaleSessionError(retryErr)) {
                    console.error(`[WA] Stale session on retry for ${deviceId}: ${retryErr.message}`);
                    await this._forceReconnect(deviceId, 'stale_session_detached_retry');
                    throw new Error('WhatsApp session was stale and is reconnecting. Please retry in a moment.');
                }
                if (this._isWwebGetChatUndefinedError(retryErr)) {
                    await this._wait(600);
                    await this._ensureChatReady(liveDs.client, chatId);
                    return await sendFn(liveDs.client);
                }
                if (this._isTransientProtocolError(retryErr)) {
                    console.warn(`[WA] ${label} retry hit transient protocol error, retrying once more: ${retryErr.message}`);
                    await this._wait(1200);
                    const retryDs = this._devState(deviceId);
                    if (!retryDs.client || retryDs.status !== 'ready') {
                        throw new Error('WhatsApp session disconnected during retry. Please wait a moment and try again.');
                    }
                    return await sendFn(retryDs.client);
                }
                if (this._isDetachedFrameError(retryErr)) {
                    // Second detached frame in a row — now check if browser is truly dead
                    try {
                        const browserAlive = liveDs.client?.pupBrowser?.isConnected?.() ?? false;
                        const pageClosed = liveDs.client?.pupPage?.isClosed?.() ?? true;
                        if (!browserAlive || pageClosed) {
                            await this._forceReconnect(deviceId, 'detached_frame_persistent');
                            throw new Error('WhatsApp session disconnected. Please wait a moment and try again.');
                        }
                    } catch {}
                    // Browser alive but frame detached twice — throw soft error, don't destroy
                    throw new Error('Temporary WhatsApp browser error. Please try again in a moment.');
                }
                throw retryErr;
            }
        }

        // No client or not ready — force reconnect
        if (liveDs.client) {
            await this._forceReconnect(deviceId, reason);
        }
        throw new Error('WhatsApp session disconnected. Please wait a moment and try again.');
    }

    async sendText(to, message, options = {}, deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        const ds = this._devState(devId);
        this._assertDeviceReady(ds, devId);
        const chatId = this._formatNumber(to);
        if (this._isOutgoingSendDuplicate(devId, chatId, message)) {
            return { id: null, to: chatId, timestamp: Math.floor(Date.now() / 1000), is_read: 1, deduplicated: true };
        }
        let result;
        if (options.quotedMessageId) {
            const targetMsg = await this._findChatMessageById(ds.client, chatId, options.quotedMessageId);
            if (!targetMsg) throw new Error('Quoted message not found in target chat');
            result = await targetMsg.reply(message, chatId);
        } else {
            // Ensure chat exists to avoid sporadic WA-web "getChat" undefined errors
            await this._ensureChatReady(ds.client, chatId);
            try {
                result = await ds.client.sendMessage(chatId, message);
            } catch (err) {
                if (this._isWwebGetChatUndefinedError(err)) {
                    await new Promise(r => setTimeout(r, 600));
                    await this._ensureChatReady(ds.client, chatId);
                    result = await ds.client.sendMessage(chatId, message);
                } else if (this._isStaleSessionError(err)) {
                    // Session is zombie — force reconnect and inform caller
                    console.error(`[WA] Stale session detected for ${devId}: ${err.message}`);
                    await this._forceReconnect(devId, 'stale_session_send');
                    throw new Error('WhatsApp session was stale and is reconnecting. Please retry in a moment.');
                } else if (this._isDetachedFrameError(err)) {
                    result = await this._retrySendAfterDetachedFrame(
                        devId,
                        chatId,
                        'sendText',
                        (client) => client.sendMessage(chatId, message),
                        'detached_frame_send_text'
                    );
                } else if (this._isTransientProtocolError(err)) {
                    // Transient protocol error — retry once after short delay
                    console.warn(`[WA] Transient protocol error in sendText, retrying: ${err.message}`);
                    await new Promise(r => setTimeout(r, 1500));
                    if (!ds.client || ds.status !== 'ready') {
                        throw new Error('WhatsApp session disconnected during retry. Please wait a moment and try again.');
                    }
                    result = await ds.client.sendMessage(chatId, message);
                } else {
                    throw err;
                }
            }
        }
        if (result.id?.id) this._trackSentMsgId(result.id.id);

        const recipient = await this._resolveOutgoingRecipient(chatId, ds.client);
        const logTo = this._normalizeLogNumber(recipient.raw || recipient.jid || chatId, { isGroup: chatId.includes('@g.us') });
        if (!logTo) {
            return { id: result.id?.id, to: recipient.jid || chatId, timestamp: result.timestamp, is_read: 1, skipped_log: true };
        }
        try {
            await this._insertMessageLog({
                deviceId: devId,
                direction: 'out',
                fromNum: null,
                toNum: logTo,
                body: message,
                type: 'chat',
                isGroup: chatId.includes('@g.us') ? 1 : 0,
                msgId: result.id?.id || null,
                isRead: 1,
            });
        } catch (e) {
            console.error('[WA] Failed to save outgoing msg:', e.message);
        }

        const payload = {
            id: result.id?.id,
            device_id: devId,
            to: recipient.jid || chatId,
            to_num: logTo,
            body: message,
            type: 'chat',
            hasMedia: false,
            mime_type: null,
            file_name: null,
            media_data: null,
            timestamp: result.timestamp,
        };
        this._broadcast('message_sent', payload);
        webhookService.dispatch('message_sent', payload, devId);
        return { id: result.id?.id, to: recipient.jid || chatId, timestamp: result.timestamp, is_read: 1 };
    }

    async sendMedia(to, mediaUrl, caption = '', mimeType = null, options = {}, deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        const ds = this._devState(devId);
        this._assertDeviceReady(ds, devId);
        const chatId = this._formatNumber(to);
        const dedupBody = `media:${caption || ''}:${mediaUrl?.slice(-40) || ''}`;
        if (this._isOutgoingSendDuplicate(devId, chatId, dedupBody)) {
            return { id: null, to: chatId, timestamp: Math.floor(Date.now() / 1000), deduplicated: true };
        }
        let media;
        if (mediaUrl.startsWith('data:')) {
            const [meta, data] = mediaUrl.split(',');
            const mime = mimeType || meta.match(/:(.*?);/)[1];
            media = new MessageMedia(mime, data);
        } else {
            media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
        }
        let result;
        if (options.quotedMessageId) {
            const targetMsg = await this._findChatMessageById(ds.client, chatId, options.quotedMessageId);
            if (!targetMsg) throw new Error('Quoted message not found in target chat');
            const replyOptions = caption ? { caption } : {};
            result = await targetMsg.reply(media, chatId, replyOptions);
        } else {
            const sendOptions = caption ? { caption } : {};
            await this._ensureChatReady(ds.client, chatId);
            try {
                result = await ds.client.sendMessage(chatId, media, sendOptions);
            } catch (err) {
                if (this._isWwebGetChatUndefinedError(err)) {
                    await new Promise(r => setTimeout(r, 600));
                    await this._ensureChatReady(ds.client, chatId);
                    result = await ds.client.sendMessage(chatId, media, sendOptions);
                } else if (this._isStaleSessionError(err)) {
                    console.error(`[WA] Stale session detected for ${devId}: ${err.message}`);
                    await this._forceReconnect(devId, 'stale_session_send_media');
                    throw new Error('WhatsApp session was stale and is reconnecting. Please retry in a moment.');
                } else if (this._isDetachedFrameError(err)) {
                    result = await this._retrySendAfterDetachedFrame(
                        devId,
                        chatId,
                        'sendMedia',
                        (client) => client.sendMessage(chatId, media, sendOptions),
                        'detached_frame_send_media'
                    );
                } else if (this._isTransientProtocolError(err)) {
                    console.warn(`[WA] Transient protocol error in sendMedia, retrying: ${err.message}`);
                    await new Promise(r => setTimeout(r, 1500));
                    if (!ds.client || ds.status !== 'ready') {
                        throw new Error('WhatsApp session disconnected during retry. Please wait a moment and try again.');
                    }
                    result = await ds.client.sendMessage(chatId, media, sendOptions);
                } else {
                    throw err;
                }
            }
        }
        if (result.id?.id) this._trackSentMsgId(result.id.id);

        const recipient = await this._resolveOutgoingRecipient(chatId, ds.client);
        const logTo = this._normalizeLogNumber(recipient.raw || recipient.jid || chatId, { isGroup: chatId.includes('@g.us') });
        if (!logTo) {
            return { id: result.id?.id, to: recipient.jid || chatId, timestamp: result.timestamp, skipped_log: true };
        }
        try {
            await this._insertMessageLog({
                deviceId: devId,
                direction: 'out',
                fromNum: null,
                toNum: logTo,
                body: caption || null,
                type: 'media',
                isGroup: chatId.includes('@g.us') ? 1 : 0,
                msgId: result.id?.id || null,
                mimeType: media.mimetype || mimeType || null,
                fileName: media.filename || null,
                mediaData: media.data ? `data:${media.mimetype || mimeType};base64,${media.data}` : null,
                isRead: 1,
            });
        } catch (e) {
            console.error('[WA] Failed to save outgoing media msg:', e.message);
        }

        const payload = {
            id: result.id?.id,
            device_id: devId,
            to: recipient.jid || chatId,
            to_num: logTo,
            body: caption || '',
            type: 'media',
            hasMedia: true,
            mime_type: media.mimetype || mimeType || null,
            file_name: media.filename || null,
            media_data: media.data ? `data:${media.mimetype || mimeType};base64,${media.data}` : null,
            timestamp: result.timestamp,
        };
        this._broadcast('message_sent', payload);
        webhookService.dispatch('message_sent', payload, devId);
        return { id: result.id?.id, to: recipient.jid || chatId, timestamp: result.timestamp };
    }

    async sendSticker(to, mediaUrl, mimeType = null, deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        const ds = this._devState(devId);
        this._assertDeviceReady(ds, devId);
        const chatId = this._formatNumber(to);
        let media;
        if (mediaUrl.startsWith('data:')) {
            const [meta, data] = mediaUrl.split(',');
            const mime = mimeType || meta.match(/:(.*?);/)[1];
            media = new MessageMedia(mime, data);
        } else {
            media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
        }
        await this._ensureChatReady(ds.client, chatId);
        let result;
        try {
            result = await ds.client.sendMessage(chatId, media, { sendMediaAsSticker: true });
        } catch (err) {
            if (this._isWwebGetChatUndefinedError(err)) {
                await new Promise(r => setTimeout(r, 600));
                await this._ensureChatReady(ds.client, chatId);
                result = await ds.client.sendMessage(chatId, media, { sendMediaAsSticker: true });
            } else if (this._isDetachedFrameError(err)) {
                result = await this._retrySendAfterDetachedFrame(
                    devId,
                    chatId,
                    'sendSticker',
                    (client) => client.sendMessage(chatId, media, { sendMediaAsSticker: true }),
                    'detached_frame_send_sticker'
                );
            } else if (this._isTransientProtocolError(err)) {
                console.warn(`[WA] Transient protocol error in sendSticker, retrying: ${err.message}`);
                await new Promise(r => setTimeout(r, 1500));
                if (!ds.client || ds.status !== 'ready') {
                    throw new Error('WhatsApp session disconnected during retry. Please wait a moment and try again.');
                }
                result = await ds.client.sendMessage(chatId, media, { sendMediaAsSticker: true });
            } else {
                throw err;
            }
        }
        if (result.id?.id) this._trackSentMsgId(result.id.id);
        try {
            await this._insertMessageLog({
                deviceId: devId,
                direction: 'out',
                fromNum: null,
                toNum: chatId,
                body: null,
                type: 'sticker',
                isGroup: chatId.includes('@g.us') ? 1 : 0,
                msgId: result.id?.id || null,
                mimeType: media.mimetype || mimeType || null,
                fileName: media.filename || null,
                mediaData: media.data ? `data:${media.mimetype || mimeType};base64,${media.data}` : null,
                isRead: 1,
            });
        } catch (e) {
            console.error('[WA] Failed to save outgoing sticker msg:', e.message);
        }
        const payload = {
            id: result.id?.id,
            device_id: devId,
            to: chatId,
            to_num: chatId,
            body: null,
            type: 'sticker',
            hasMedia: true,
            mime_type: media.mimetype || mimeType || null,
            file_name: media.filename || null,
            media_data: media.data ? `data:${media.mimetype || mimeType};base64,${media.data}` : null,
            timestamp: result.timestamp,
        };
        this._broadcast('message_sent', payload);
        webhookService.dispatch('message_sent', payload, devId);
        return { id: result.id?.id, to: chatId, timestamp: result.timestamp, type: 'sticker' };
    }

    async sendBulk(numbers, message, delay = 2000, deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        this._assertDeviceReady(this._devState(devId), devId);
        const results = [];
        for (const num of numbers) {
            try {
                const r = await this.sendText(num, message, {}, devId);
                results.push({ number: num, success: true, ...r });
            } catch (err) {
                results.push({ number: num, success: false, error: err.message });
            }
            if (delay > 0 && numbers.indexOf(num) < numbers.length - 1) {
                await new Promise(r => setTimeout(r, delay));
            }
        }
        return results;
    }

    async sendTyping(to, duration = 3000, deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        const ds = this._devState(devId);
        this._assertDeviceReady(ds, devId);
        const chatId = this._formatNumber(to);
        const chat = await ds.client.getChatById(chatId);
        await chat.sendStateTyping();
        setTimeout(async () => {
            await chat.clearState().catch(() => {});
        }, duration);
        return { chatId, duration };
    }

    async sendReaction(chatId, messageId, emoji, deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        const ds = this._devState(devId);
        this._assertDeviceReady(ds, devId);
        if (!chatId || !messageId || emoji === undefined || emoji === null) throw new Error('Missing: chatId, messageId, emoji');
        const formattedChatId = this._formatNumber(chatId);
        const target = await this._findChatMessageById(ds.client, formattedChatId, messageId, 300);
        if (!target) throw new Error('Target message not found for reaction');
        const reaction = String(emoji);
        await target.react(reaction);
        return { chatId: formattedChatId, messageId, emoji: reaction };
    }

    async revokeMessage(chatId, messageId, mode = 'MESSAGE_REVOKED_EVERYONE', deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        const ds = this._devState(devId);
        this._assertDeviceReady(ds, devId);
        if (!chatId || !messageId) throw new Error('Missing: chatId, messageId');
        const normalizedMode = mode === 'MESSAGE_REVOKED_ME' ? 'MESSAGE_REVOKED_ME' : 'MESSAGE_REVOKED_EVERYONE';
        const formattedChatId = this._formatNumber(chatId);
        const target = await this._findChatMessageById(ds.client, formattedChatId, messageId, 500);
        if (!target) throw new Error('Target message not found for revoke');
        await target.delete(normalizedMode === 'MESSAGE_REVOKED_EVERYONE');
        const resolvedId = target.id?.id || String(messageId);
        try {
            await query('DELETE FROM message_logs WHERE device_id = ? AND msg_id = ?', [devId, resolvedId]);
        } catch (e) {
            console.error('[WA] Failed to delete revoked outgoing msg log:', e.message);
        }
        const payload = {
            device_id: devId,
            chatId: formattedChatId,
            messageId: resolvedId,
            mode: normalizedMode,
        };
        this._broadcast('message_revoked', payload);
        webhookService.dispatch('message_revoked', payload, devId);
        return payload;
    }

    async getChats(limit = 20, deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        const ds = this._devState(devId);
        this._assertDeviceReady(ds, devId);
        const chats = await ds.client.getChats();
        return chats.slice(0, limit).map(c => ({
            id: c.id?._serialized,
            name: c.name,
            isGroup: c.isGroup,
            unreadCount: c.unreadCount,
            timestamp: c.timestamp,
            lastMessage: c.lastMessage ? {
                body: c.lastMessage.body,
                type: c.lastMessage.type,
                fromMe: c.lastMessage.fromMe,
                timestamp: c.lastMessage.timestamp,
            } : null,
        }));
    }

    async getContacts(deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        const ds = this._devState(devId);
        this._assertDeviceReady(ds, devId);
        const contacts = await ds.client.getContacts();
        return contacts
            .filter(c => c.isMyContact && !c.isGroup)
            .map(c => ({
                id: c.id?._serialized,
                name: c.pushname || c.name || c.number,
                number: c.number,
                isMyContact: c.isMyContact,
                isBlocked: c.isBlocked,
            }));
    }

    async getMessages(chatId, limit = 20, deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        const ds = this._devState(devId);
        this._assertDeviceReady(ds, devId);
        const chat = await ds.client.getChatById(chatId);
        const msgs = await chat.fetchMessages({ limit });
        return msgs.map(m => ({
            id: m.id?.id,
            from: m.from,
            body: m.body,
            type: m.type,
            fromMe: m.fromMe,
            timestamp: m.timestamp,
            hasMedia: m.hasMedia,
            ack: m.ack,
        }));
    }

    async checkNumber(number, deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        const ds = this._devState(devId);
        this._assertDeviceReady(ds, devId);
        const formatted = this._formatNumber(number);
        const result = await ds.client.isRegisteredUser(formatted);
        return { number, formatted, isRegistered: result };
    }

    async getProfilePic(number, deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        const ds = this._devState(devId);
        this._assertDeviceReady(ds, devId);
        const formatted = this._formatNumber(number);
        try {
            const url = await ds.client.getProfilePicUrl(formatted);
            return { number, url };
        } catch {
            return { number, url: null };
        }
    }

    async requestPairingCode(phoneNumber, showNotification = true, intervalMs = 180000, deviceId = null) {
        const normalizedNumber = String(phoneNumber || '').replace(/\D/g, '');
        const normalizedIntervalMs = Number(intervalMs) || 180000;
        if (!normalizedNumber) throw new Error('phoneNumber is required');
        if (deviceId) this.setCurrentDevice(deviceId);
        const targetDeviceId = this.currentDeviceId;
        const pairingCodePromise = this._createPairingWaiter(targetDeviceId, Math.max(30000, normalizedIntervalMs));
        try {
            await this.initialize(targetDeviceId, {
                pairWithPhoneNumber: {
                    phoneNumber: normalizedNumber,
                    showNotification: showNotification !== false,
                    intervalMs: normalizedIntervalMs,
                },
            });
            await this._waitForPairingCodeSupport(targetDeviceId);
            const pairingCode = await pairingCodePromise;
            this._broadcast('pairing_code', { device_id: targetDeviceId, phoneNumber: normalizedNumber, pairingCode });
            return { device_id: targetDeviceId, phoneNumber: normalizedNumber, pairingCode };
        } catch (err) {
            const rawMessage = String(err?.message || err || 'Unknown error');
            if (rawMessage.includes('window.onCodeReceivedEvent is not a function')) {
                this._rejectPairingWaiter(targetDeviceId, new Error(rawMessage));
                throw new Error('Pairing code initialization is invalid for the current flow. The client must be initialized with pairWithPhoneNumber before requesting a code.');
            }
            throw new Error(`Failed to request pairing code: ${err.message}`);
        }
    }

    async logout(deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        this._suppressReconnect(devId, 60 * 1000, 'logout');
        const ds = this._devState(devId);
        if (ds.client) {
            await ds.client.logout().catch(() => {});
        }
        await this._destroyClient(devId);
        this._clearDeviceScopedCaches(devId);
        const purgeResult = await this._purgeSessionFolders(devId, { strict: true });
        query('UPDATE devices SET status = ?, phone = NULL, pushname = NULL, platform = NULL, updated_at = NOW() WHERE device_id = ?', ['disconnected', devId]).catch(() => {});
        this._broadcast('status', { status: 'disconnected', device_id: devId });
        this._broadcast('disconnected', { reason: 'manual_logout', device_id: devId });
        webhookService.dispatch('disconnected', { reason: 'manual_logout' }, devId);
        return purgeResult;
    }

    async purgeSessionData(deviceId, strict = true) {
        const devId = String(deviceId || this.currentDeviceId || '').trim();
        if (!devId) throw new Error('device_id is required to purge session data');
        return this._purgeSessionFolders(devId, { strict });
    }

    async stop(deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        this._suppressReconnect(devId, 60 * 1000, 'stop');
        this._initPromises.delete(devId);
        await this._destroyClient(devId);
    }

    async restart(deviceId = null) {
        if (deviceId) this.setCurrentDevice(deviceId);
        const devId = this.currentDeviceId;
        this._suppressReconnect(devId, 30 * 1000, 'restart');
        await this._destroyClient(devId);
        const ds = this._devState(devId);
        ds.status = 'connecting';
        ds._connectingSince = Date.now();
        query('UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?', ['connecting', devId]).catch(() => {});
        this._broadcast('status', { status: 'connecting', device_id: devId });
        await this.initialize(devId);
    }

    _formatNumber(number) {
        const s = number.toString().trim();
        // Already a fully-qualified JID (@c.us / @lid / @g.us) — pass through
        if (s.includes('@')) return s;
        // Plain digits — strip non-digits and normalise to @c.us
        return `${s.replace(/\D/g, '')}@c.us`;
    }

    _normalizeLogNumber(value, { isGroup = false } = {}) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        if (raw.includes('@lid') || raw.includes('lid')) return ''; // never persist LID in any form
        if (raw === 'status@broadcast') return ''; // skip status broadcasts
        if (isGroup) {
            return raw;
        }
        const cleaned = raw
            .replace(/:\d+@/g, '@')
            .replace(/@(c\.us|lid|s\.whatsapp\.net|g\.us)$/i, '')
            .replace(/\D/g, '');
        // Real phone numbers (E.164) are 8–14 digits; anything longer is likely a LID numeric part
        if (cleaned.length < 8 || cleaned.length > 14) return '';
        return cleaned;
    }

    _assertDeviceReady(ds, devId) {
        if (!ds.client || ds.status !== 'ready') {
            throw new Error(`WhatsApp not ready for device '${devId}'. Status: ${ds.status}`);
        }
    }

    _assertReady(deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        this._assertDeviceReady(this._devState(devId), devId);
    }

    getStatus(deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        const ds = this._devState(devId);
        return {
            status: ds.status,
            info: this._sanitizeInfo(ds.info),
            qrCode: ds.qrCode,
            qrBase64: ds.qrBase64,
            uptime: Math.floor(process.uptime()),
            device_id: devId,
        };
    }

    hasClient(deviceId = null) {
        const devId = deviceId || this.currentDeviceId;
        return !!this._devState(devId).client;
    }

}

module.exports = new WhatsAppService();
