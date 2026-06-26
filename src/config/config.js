require('dotenv').config();

const path = require('path');

const isProduction = process.env.NODE_ENV === 'production';

const sessionSecret = process.env.SESSION_SECRET ? String(process.env.SESSION_SECRET) : '';

const dbHost = process.env.DB_HOST ? String(process.env.DB_HOST) : '';
const dbUser = process.env.DB_USER ? String(process.env.DB_USER) : '';
const dbPassword = process.env.DB_PASSWORD ? String(process.env.DB_PASSWORD) : '';
const dbName = process.env.DB_NAME ? String(process.env.DB_NAME) : '';

const dbPort = Number.parseInt(String(process.env.DB_PORT || ''), 10);
const resolvedDbPort = Number.isFinite(dbPort) && dbPort > 0 ? dbPort : 3306;

const serverHost = process.env.HOST ? String(process.env.HOST) : '';
const serverPortRaw = Number.parseInt(String(process.env.PORT || ''), 10);
const frontendPortRaw = Number.parseInt(String(process.env.FRONTEND_PORT || ''), 10);
const serverPort = Number.isFinite(serverPortRaw) && serverPortRaw > 0 ? serverPortRaw : 0;
const frontendPort = Number.isFinite(frontendPortRaw) && frontendPortRaw > 0 ? frontendPortRaw : serverPort;

const rlWindow = Number.parseInt(String(process.env.RATE_LIMIT_WINDOW_MS || ''), 10);
const rlMax = Number.parseInt(String(process.env.RATE_LIMIT_MAX || ''), 10);

const resolvedRateLimitWindowMs = Number.isFinite(rlWindow) && rlWindow > 0 ? rlWindow : 60000;
const resolvedRateLimitMax = Number.isFinite(rlMax) && rlMax > 0 ? rlMax : 1200;

{
    const missing = [];
    if (!sessionSecret) missing.push('SESSION_SECRET');
    if (!dbHost) missing.push('DB_HOST');
    if (!dbUser) missing.push('DB_USER');
    if (!dbName) missing.push('DB_NAME');
    if (!serverHost) missing.push('HOST');
    if (!serverPort) missing.push('PORT');
    if (missing.length) {
        const mode = isProduction ? 'production' : 'development';
        throw new Error(`Missing required .env values (${mode}): ${missing.join(', ')}`);
    }
}

const defaultSessionRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'wa-gateway', 'sessions')
    : process.env.XDG_DATA_HOME
        ? path.join(process.env.XDG_DATA_HOME, 'wa-gateway', 'sessions')
        : path.resolve(process.cwd(), 'sessions');

module.exports = {
    server: {
        port:          serverPort,
        host:          serverHost,
        frontendPort,
    },
    auth: {
        sessionSecret,
    },
    session: {
        name:       process.env.SESSION_NAME,
        path:       process.env.SESSION_PATH ? path.resolve(process.env.SESSION_PATH) : defaultSessionRoot,
        chromePath: process.env.CHROME_PATH || null,
    },
    rateLimit: {
        windowMs: resolvedRateLimitWindowMs,
        max:      resolvedRateLimitMax,
    },
    webhook: {
        timeout: parseInt(process.env.WEBHOOK_TIMEOUT || '10000', 10),
        retry:   parseInt(process.env.WEBHOOK_RETRY || '3', 10),
        messageDelayMs: parseInt(process.env.WEBHOOK_MESSAGE_DELAY_MS || '0', 10),
        messageDelayOptionsMs: String(process.env.WEBHOOK_MESSAGE_DELAY_OPTIONS || '')
            .split(',')
            .map(v => Number.parseInt(v.trim(), 10))
            .filter(v => Number.isFinite(v) && v >= 0),
    },
    features: {
        autoReadMessages: process.env.AUTO_READ_MESSAGES === 'true',
        autoRejectTyping: process.env.AUTO_REJECT_TYPING === 'true',
        autoReconnect: process.env.AUTO_RECONNECT !== 'false',
        incomingAckReplyEnabled: process.env.INCOMING_ACK_REPLY !== 'false',
        incomingAckReplyText: process.env.INCOMING_ACK_REPLY_TEXT || '',
        incomingAckReplyOnGroups: process.env.INCOMING_ACK_REPLY_ON_GROUPS === 'true',
    },
    db: {
        host:     dbHost,
        port:     resolvedDbPort,
        user:     dbUser,
        password: dbPassword,
        database: dbName,
    },
};
