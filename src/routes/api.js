const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { apiKeyAuth } = require('../middleware/auth');
const waService = require('../services/whatsappService');
const webhookService = require('../services/webhookService');

const ROLE_SECTIONS = {
    admin: ['dashboard', 'device', 'messages', 'testing', 'blast', 'history', 'logs', 'integrasi', 'docs', 'users', 'settings'],
    cs: ['messages', 'testing', 'blast', 'history', 'logs', 'integrasi', 'docs', 'settings'],
    operator: ['messages', 'testing', 'blast', 'integrasi', 'docs', 'settings'],
};

const MESSAGE_LOG_IGNORED_TYPES = [
    'e2e_notification',
    'notification',
    'notification_template',
    'call_log',
    'gp2',
    'revoked',
    'ciphertext',
    'protocol',
];

function requireSessionSection(section) {
    return (req, res, next) => {
        // API key clients (non-session) keep existing behavior
        if (!req.session?.authenticated) return next();
        const role = req.session.userRole || 'operator';
        const allowed = Array.isArray(req.session.allowedSections) && req.session.allowedSections.length
            ? req.session.allowedSections
            : (ROLE_SECTIONS[role] || ROLE_SECTIONS.operator);
        if (allowed.includes('docs') && !allowed.includes('integrasi')) allowed.push('integrasi');
        if (allowed.includes('integrasi') && !allowed.includes('docs')) allowed.push('docs');
        if (!allowed.includes(section)) {
            return res.status(403).json({ success: false, message: `Access denied: ${section} section required` });
        }
        next();
    };
}

async function _bindCurrentDevice(req) {
    const explicit = req.body?.device_id || req.query?.device_id || null;
    let deviceId = explicit || req.deviceId || null;
    if (!deviceId) {
        deviceId = await _findReadyDevice();
    }
    if (deviceId) waService.setCurrentDevice(deviceId);
    return deviceId;
}

async function _findReadyDevice() {
    const { query } = require('../db/database');
    try {
        for (const [deviceId] of waService._clients.entries()) {
            const live = waService.getStatus(deviceId);
            if (waService.hasClient(deviceId) && live.status === 'ready') {
                return deviceId;
            }
        }
        const rows = await query('SELECT device_id FROM devices WHERE status = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1', ['ready']);
        if (rows && rows.length > 0) {
            return rows[0].device_id;
        }
    } catch {}
    return null;
}

function _assertBoundReadyDevice(deviceId) {
    if (!deviceId) {
        const err = new Error('Missing device_id for this request');
        err.statusCode = 400;
        throw err;
    }
    const status = waService.getStatus(deviceId);
    if (status.status !== 'ready') {
        const err = new Error(`WhatsApp not ready for device '${deviceId}'. Status: ${status.status}`);
        err.statusCode = 409;
        throw err;
    }
    return status;
}

function _sendRouteError(res, err, context) {
    const rawMessage = err instanceof Error ? err.message : String(err || 'Internal server error');
    const statusCode = err?.statusCode
        || (rawMessage.includes('Quoted message not found') ? 400 : 500);
    console.error(`[API] ${context} failed:`, err?.stack || rawMessage);
    res.status(statusCode).json({ success: false, message: rawMessage || 'Internal server error' });
}

let _lastCleanupAt = 0;
const _CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // run at most once per 5 minutes

async function _cleanupMessageLogs(dbQuery, deviceId = null) {
    const now = Date.now();
    if (now - _lastCleanupAt < _CLEANUP_INTERVAL_MS) return; // skip if recently ran
    _lastCleanupAt = now;

    const deviceClause = deviceId ? ' AND device_id = ?' : '';
    const params = deviceId ? [deviceId] : [];

    // Step 1: normalize old JID-format numbers (strip @c.us / @s.whatsapp.net) — batch limit to avoid locking
    await dbQuery(
        `UPDATE message_logs SET from_num = REPLACE(REPLACE(from_num, '@c.us', ''), '@s.whatsapp.net', '')
         WHERE is_group = 0 AND (from_num LIKE '%@c.us' OR from_num LIKE '%@s.whatsapp.net')${deviceClause} LIMIT 500`,
        params
    );
    await dbQuery(
        `UPDATE message_logs SET to_num = REPLACE(REPLACE(to_num, '@c.us', ''), '@s.whatsapp.net', '')
         WHERE is_group = 0 AND (to_num LIKE '%@c.us' OR to_num LIKE '%@s.whatsapp.net')${deviceClause} LIMIT 500`,
        params
    );

    // Step 2: delete junk rows — batch limit to prevent sort buffer overflow
    await dbQuery(
        `DELETE FROM message_logs
         WHERE (
            from_num LIKE '%@lid%'
            OR to_num LIKE '%@lid%'
            OR from_num LIKE '%lid%'
            OR to_num LIKE '%lid%'
            OR from_num = 'status@broadcast'
            OR to_num = 'status@broadcast'
            OR type IN (${MESSAGE_LOG_IGNORED_TYPES.map(() => '?').join(', ')})
            OR (is_group = 0 AND from_num REGEXP '^[0-9]{15,}$')
            OR (is_group = 0 AND to_num REGEXP '^[0-9]{15,}$')
         )${deviceClause} LIMIT 1000`,
        [...MESSAGE_LOG_IGNORED_TYPES, ...params]
    );

    // Step 3: purge all logs older than 24 hours
    await dbQuery(`DELETE FROM webhook_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR) LIMIT 2000`);
}

function _messageLogCleanWhere(alias = '') {
    const p = alias ? `${alias}.` : '';
    const ignored = MESSAGE_LOG_IGNORED_TYPES.map(v => `'${v}'`).join(', ');
    return `${p}type NOT IN (${ignored})
        AND (${p}from_num IS NULL OR ${p}from_num NOT LIKE '%lid%')
        AND (${p}to_num IS NULL OR ${p}to_num NOT LIKE '%lid%')
        AND (${p}is_group = 1 OR ${p}from_num IS NULL OR CHAR_LENGTH(${p}from_num) <= 14)
        AND (${p}is_group = 1 OR ${p}to_num IS NULL OR CHAR_LENGTH(${p}to_num) <= 14)`;
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 16 * 1024 * 1024 },
});

// ─── Status & QR ──────────────────────────────────────────────────────────────

router.get('/ready-device', async (req, res) => {
    try {
        const readyDeviceId = await _findReadyDevice();
        if (readyDeviceId) {
            const status = waService.getStatus(readyDeviceId);
            res.json({ 
                success: true, 
                data: { 
                    device_id: readyDeviceId,
                    status: status.status,
                    info: status.info,
                } 
            });
        } else {
            res.status(404).json({ success: false, message: 'No ready device found' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─── Health Check (no auth) ──────────────────────────────────────────────────
router.get('/health', (req, res) => {
    const memUsage = process.memoryUsage();
    const devices = [];
    for (const [deviceId] of waService._clients.entries()) {
        const s = waService.getStatus(deviceId);
        devices.push({ device_id: deviceId, status: s.status });
    }
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        memory: {
            rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
            heap: Math.round(memUsage.heapUsed / 1024 / 1024) + '/' + Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
        },
        devices,
        timestamp: new Date().toISOString(),
    });
});

router.get('/status', async (req, res) => {
    try {
        const reqDeviceId = await _bindCurrentDevice(req);
        const base = waService.getStatus(reqDeviceId);
        const deviceId = base.device_id;

        // Webhooks for this device
        let webhooks = [];
        try {
            webhooks = await webhookService.list(deviceId);
        } catch {}

        const activeWebhooks  = webhooks.filter(w => w.active);
        const webhookSummary  = {
            total:  webhooks.length,
            active: activeWebhooks.length,
            list:   webhooks.map(w => ({
                id:          w.id,
                url:         w.url,
                events:      w.events,
                active:      w.active,
                description: w.description || null,
                stats:       w.stats,
            })),
        };

        res.json({
            success: true,
            data: {
                ...base,
                webhooks: webhookSummary,
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/qr', (req, res) => {
    const requestedDeviceId = req.query.device_id || req.deviceId || null;
    const status = waService.getStatus(requestedDeviceId);
    if (status.status !== 'qr' || !status.qrBase64) {
        return res.status(404).json({ success: false, message: 'No QR code available' });
    }
    res.json({ success: true, data: { qr: status.qrBase64, device_id: status.device_id } });
});

router.post('/pairing-code', apiKeyAuth, requireSessionSection('device'), async (req, res) => {
    try {
        const deviceId = await _bindCurrentDevice(req);
        const {
            phoneNumber,
            showNotification = true,
            intervalMs = 180000,
        } = req.body || {};
        if (!phoneNumber) {
            return res.status(400).json({ success: false, message: 'Missing: phoneNumber' });
        }
        const result = await waService.requestPairingCode(
            phoneNumber,
            showNotification !== false,
            Number(intervalMs) || 180000,
            deviceId || null
        );
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─── Send Messages ─────────────────────────────────────────────────────────────

router.post('/send', apiKeyAuth, async (req, res) => {
    try {
        const deviceId = await _bindCurrentDevice(req);
        const { to, message, quotedMessageId } = req.body;
        if (!to || !message) return res.status(400).json({ success: false, message: 'Missing: to, message' });

        _assertBoundReadyDevice(deviceId);

        const result = await waService.sendText(to, message, { quotedMessageId }, deviceId);
        res.json({ success: true, data: result });
    } catch (err) {
        _sendRouteError(res, err, 'POST /api/send');
    }
});

router.post('/send/bulk', apiKeyAuth, async (req, res) => {
    try {
        const deviceId = await _bindCurrentDevice(req);
        const { numbers, message, delay } = req.body;
        if (!numbers?.length || !message) return res.status(400).json({ success: false, message: 'Missing: numbers[], message' });
        _assertBoundReadyDevice(deviceId);
        const results = await waService.sendBulk(numbers, message, delay || 2000, deviceId);
        res.json({ success: true, data: results });
    } catch (err) {
        _sendRouteError(res, err, 'POST /api/send/bulk');
    }
});

router.post('/send/media', apiKeyAuth, upload.single('file'), async (req, res) => {
    try {
        const deviceId = await _bindCurrentDevice(req);
        const { to, caption, mediaUrl, asSticker, quotedMessageId } = req.body;
        if (!to) return res.status(400).json({ success: false, message: 'Missing: to' });
        _assertBoundReadyDevice(deviceId);
        const sendAsSticker = asSticker === '1' || asSticker === 'true' || asSticker === true;

        let result;
        if (req.file) {
            const base64 = req.file.buffer.toString('base64');
            const dataUrl = `data:${req.file.mimetype};base64,${base64}`;
            result = sendAsSticker
                ? await waService.sendSticker(to, dataUrl, req.file.mimetype, deviceId)
                : await waService.sendMedia(to, dataUrl, caption || '', req.file.mimetype, { quotedMessageId }, deviceId);
        } else if (mediaUrl) {
            result = sendAsSticker
                ? await waService.sendSticker(to, mediaUrl, null, deviceId)
                : await waService.sendMedia(to, mediaUrl, caption || '', null, { quotedMessageId }, deviceId);
        } else {
            return res.status(400).json({ success: false, message: 'Missing: file or mediaUrl' });
        }
        res.json({ success: true, data: result });
    } catch (err) {
        _sendRouteError(res, err, 'POST /api/send/media');
    }
});

router.post('/send/typing', apiKeyAuth, async (req, res) => {
    try {
        const deviceId = await _bindCurrentDevice(req);
        const { to, duration } = req.body;
        if (!to) return res.status(400).json({ success: false, message: 'Missing: to' });
        _assertBoundReadyDevice(deviceId);
        const result = await waService.sendTyping(to, duration || 3000, deviceId);
        res.json({ success: true, data: result });
    } catch (err) {
        _sendRouteError(res, err, 'POST /api/send/typing');
    }
});

router.post('/send/reaction', apiKeyAuth, async (req, res) => {
    try {
        const deviceId = await _bindCurrentDevice(req);
        const { chatId, messageId, emoji } = req.body;
        if (!chatId || !messageId || emoji === undefined || emoji === null) {
            return res.status(400).json({ success: false, message: 'Missing: chatId, messageId, emoji' });
        }
        _assertBoundReadyDevice(deviceId);
        const result = await waService.sendReaction(chatId, messageId, emoji, deviceId);
        res.json({ success: true, data: result });
    } catch (err) {
        _sendRouteError(res, err, 'POST /api/send/reaction');
    }
});

router.post('/messages/revoke', apiKeyAuth, async (req, res) => {
    try {
        const deviceId = await _bindCurrentDevice(req);
        const { chatId, messageId, mode } = req.body;
        if (!chatId || !messageId) {
            return res.status(400).json({ success: false, message: 'Missing: chatId, messageId' });
        }
        const revokeMode = mode === 'MESSAGE_REVOKED_ME' ? 'MESSAGE_REVOKED_ME' : 'MESSAGE_REVOKED_EVERYONE';
        const result = await waService.revokeMessage(chatId, messageId, revokeMode, deviceId);
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─── Contacts & Chats ─────────────────────────────────────────────────────────

router.get('/chats', apiKeyAuth, async (req, res) => {
    try {
        const deviceId = await _bindCurrentDevice(req);
        const limit = parseInt(req.query.limit) || 20;
        const chats = await waService.getChats(limit, deviceId);
        res.json({ success: true, data: chats });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/contacts', apiKeyAuth, async (req, res) => {
    try {
        const deviceId = await _bindCurrentDevice(req);
        const contacts = await waService.getContacts(deviceId);
        res.json({ success: true, data: contacts });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/messages/:chatId', apiKeyAuth, async (req, res) => {
    try {
        const deviceId = await _bindCurrentDevice(req);
        const limit = parseInt(req.query.limit) || 20;
        const msgs = await waService.getMessages(req.params.chatId, limit, deviceId);
        res.json({ success: true, data: msgs });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/check/:number', apiKeyAuth, async (req, res) => {
    try {
        const deviceId = await _bindCurrentDevice(req);
        const result = await waService.checkNumber(req.params.number, deviceId);
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/profile-pic/:number', apiKeyAuth, async (req, res) => {
    try {
        const deviceId = await _bindCurrentDevice(req);
        const result = await waService.getProfilePic(req.params.number, deviceId);
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─── Device Control ────────────────────────────────────────────────────────────

router.post('/logout', apiKeyAuth, requireSessionSection('device'), async (req, res) => {
    try {
        const deviceId = req.deviceId || req.body?.device_id;
        await waService.logout(deviceId || null);
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/restart', apiKeyAuth, requireSessionSection('device'), async (req, res) => {
    try {
        const deviceId = req.deviceId || req.body?.device_id;
        await waService.restart(deviceId || null);
        res.json({ success: true, message: 'Restarting WhatsApp service...' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/stop', apiKeyAuth, requireSessionSection('device'), async (req, res) => {
    try {
        const deviceId = req.deviceId || req.body?.device_id;
        await waService.stop(deviceId || null);
        res.json({ success: true, message: 'Stopped — QR/Pairing cancelled' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/initialize', apiKeyAuth, requireSessionSection('device'), async (req, res) => {
    try {
        const deviceId = await _bindCurrentDevice(req);
        const s = waService.getStatus(deviceId);
        if (s.status === 'ready' || s.status === 'connecting' || s.status === 'qr') {
            return res.json({ success: true, message: 'Already initialized' });
        }
        waService.initialize(deviceId || null).catch(err => console.error('[WA] Init error:', err.message));
        res.json({ success: true, message: 'Initializing WhatsApp...' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─── Message Logs ─────────────────────────────────────────────────────────────

const { query: dbQuery } = require('../db/database');

router.get('/message-logs', apiKeyAuth, requireSessionSection('history'), async (req, res) => {
    try {
        const { direction, limit = 50, offset = 0, search, device_id } = req.query;
        const params = [];
        const countParams = [];
        let where = '1=1';
        if (direction && ['in','out'].includes(direction)) {
            where += ' AND direction = ?'; params.push(direction); countParams.push(direction);
        }
        if (device_id) {
            where += ' AND device_id = ?'; params.push(device_id); countParams.push(device_id);
        }
        if (search) {
            where += ' AND (from_num LIKE ? OR to_num LIKE ? OR body LIKE ?)';
            const s = `%${search}%`;
            params.push(s, s, s); countParams.push(s, s, s);
        }
        const lim = Math.min(100, Math.max(1, parseInt(limit) || 50));
        const off = Math.max(0, parseInt(offset) || 0);
        const rows = await dbQuery(
            `SELECT id, device_id, direction, from_num, to_num, body, type, is_group, msg_id,
                    mime_type, file_name, is_read, created_at
             FROM message_logs WHERE ${where} ORDER BY id DESC LIMIT ${lim} OFFSET ${off}`,
            params
        );
        // Approximate total when not searching (avoid expensive COUNT on large table)
        const total = search
            ? (off + rows.length + (rows.length === lim ? 1 : 0))
            : ((await dbQuery(`SELECT COUNT(*) as total FROM message_logs WHERE ${where} LIMIT 1`, countParams))[0]?.total || 0);
        res.json({ success: true, data: rows, total, limit: parseInt(limit), offset: parseInt(offset) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/message-logs/stats', apiKeyAuth, requireSessionSection('history'), async (req, res) => {
    try {
        const rows = await dbQuery(`
            SELECT
                COUNT(*) as total,
                SUM(direction='in') as total_in,
                SUM(direction='out') as total_out,
                SUM(is_group=1) as total_group,
                SUM(CASE WHEN is_read=0 AND direction='in' THEN 1 ELSE 0 END) as total_unread,
                DATE(MAX(created_at)) as last_date
            FROM message_logs
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        `);
        res.json({ success: true, data: rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/message-logs/conversations', apiKeyAuth, requireSessionSection('messages'), async (req, res) => {
    try {
        const { device_id } = req.query;
        await _cleanupMessageLogs(dbQuery, device_id || null);
        const params = device_id ? [device_id] : [];
        const rows = await dbQuery(`
            SELECT m.id, m.device_id, m.direction, m.from_num, m.to_num,
                   m.body, m.type, m.is_group, m.created_at, m.is_read,
                   c.contact,
                   c.total_msgs, c.unread_count
            FROM message_logs m
            INNER JOIN (
                SELECT MAX(id) AS max_id,
                       device_id,
                       CASE WHEN direction='in' THEN from_num ELSE to_num END AS contact,
                       COUNT(*) AS total_msgs,
                       SUM(CASE WHEN is_read=0 AND direction='in' THEN 1 ELSE 0 END) AS unread_count
                FROM message_logs
                WHERE ${_messageLogCleanWhere()}
                  AND created_at >= DATE_SUB(NOW(), INTERVAL 90 DAY)
                  AND (CASE WHEN direction='in' THEN from_num ELSE to_num END) IS NOT NULL
                  AND (CASE WHEN direction='in' THEN from_num ELSE to_num END) != ''
                  ${device_id ? 'AND device_id = ?' : ''}
                GROUP BY device_id, contact
            ) c ON m.id = c.max_id
            WHERE ${_messageLogCleanWhere('m')}
            ORDER BY m.created_at DESC
            LIMIT 200
        `, params);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/message-logs/contact/:contact', apiKeyAuth, requireSessionSection('messages'), async (req, res) => {
    try {
        const contact = req.params.contact;
        const { limit = 80, device_id } = req.query;
        await _cleanupMessageLogs(dbQuery, device_id || null);
        const lim = Math.min(300, Math.max(1, parseInt(limit) || 80));
        const params = [`%${contact}%`, `%${contact}%`];
        let deviceFilter = '';
        if (device_id) { deviceFilter = 'AND device_id = ?'; params.push(device_id); }
        const rows = await dbQuery(
            `SELECT id, device_id, direction, from_num, to_num, body, type, is_group, msg_id,
                    mime_type, file_name, media_data, is_read, created_at
             FROM message_logs WHERE ${_messageLogCleanWhere()} AND (from_num LIKE ? OR to_num LIKE ?) ${deviceFilter}
             ORDER BY created_at ASC LIMIT ${lim}`,
            params
        );
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.patch('/message-logs/read-all', apiKeyAuth, requireSessionSection('messages'), async (req, res) => {
    try {
        const { contact, device_id } = req.body;
        if (!contact) return res.status(400).json({ success: false, message: 'Missing: contact' });
        const params = [`%${contact}%`, `%${contact}%`];
        let deviceFilter = '';
        if (device_id) { deviceFilter = 'AND device_id = ?'; params.push(device_id); }
        await dbQuery(
            `UPDATE message_logs SET is_read = 1 WHERE (from_num LIKE ? OR to_num LIKE ?) AND direction = 'in' ${deviceFilter}`,
            params
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.delete('/message-logs/:id', apiKeyAuth, requireSessionSection('messages'), async (req, res) => {
    try {
        const result = await dbQuery('DELETE FROM message_logs WHERE id = ?', [req.params.id]);
        if (!result.affectedRows) return res.status(404).json({ success: false, message: 'Log not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// ─── Webhooks ─────────────────────────────────────────────────────────────────

router.get('/webhook-logs', apiKeyAuth, requireSessionSection('logs'), async (req, res) => {
    try {
        const { limit = 50, offset = 0, success, event, device_id } = req.query;
        const params = [];
        const lim = Math.max(1, Math.min(100, parseInt(limit) || 50));
        const off = Math.max(0, parseInt(offset) || 0);
        let where = 'wl.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)';
        if (success !== undefined) {
            where += ' AND wl.success = ?'; params.push(parseInt(success));
        }
        if (event) {
            where += ' AND wl.event = ?'; params.push(event);
        }
        if (device_id) {
            where += ' AND wl.device_id = ?'; params.push(device_id);
        }
        const rows = await dbQuery(
            `SELECT wl.id, wl.webhook_id, wl.device_id, wl.event,
                    wl.success, wl.status_code, wl.error, wl.duration_ms, wl.created_at,
                    w.url
             FROM webhook_logs wl
             LEFT JOIN webhooks w ON wl.webhook_id = w.id
             WHERE ${where} ORDER BY wl.id DESC LIMIT ${lim} OFFSET ${off}`,
            params
        );
        const total = off + rows.length + (rows.length === lim ? 1 : 0);
        res.json({ success: true, data: rows, total });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/webhooks', apiKeyAuth, requireSessionSection('logs'), async (req, res) => {
    try {
        const deviceId = req.query.device_id || null;
        const list = await webhookService.list(deviceId);
        res.json({ success: true, data: list });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/webhooks', apiKeyAuth, requireSessionSection('logs'), async (req, res) => {
    try {
        const { url, events, description, device_id } = req.body;
        if (!url) return res.status(400).json({ success: false, message: 'Missing: url' });
        if (!device_id) return res.status(400).json({ success: false, message: 'Missing: device_id' });
        const webhook = await webhookService.add(url, events || ['message'], description || '', device_id);
        res.json({ success: true, data: webhook });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.delete('/webhooks/:id', apiKeyAuth, requireSessionSection('logs'), async (req, res) => {
    try {
        const removed = await webhookService.remove(req.params.id);
        if (!removed) return res.status(404).json({ success: false, message: 'Webhook not found' });
        res.json({ success: true, message: 'Webhook removed' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.patch('/webhooks/:id/toggle', apiKeyAuth, requireSessionSection('logs'), async (req, res) => {
    try {
        const { active } = req.body;
        const wh = await webhookService.toggle(req.params.id, active);
        if (!wh) return res.status(404).json({ success: false, message: 'Webhook not found' });
        res.json({ success: true, data: wh });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
