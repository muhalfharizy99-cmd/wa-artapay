const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const { query, queryOne } = require('../db/database');
const config  = require('../config/config');

const ROLE_SECTIONS = {
    admin: ['dashboard', 'device', 'messages', 'testing', 'blast', 'history', 'logs', 'integrasi', 'docs', 'users', 'settings'],
    cs: ['messages', 'testing', 'blast', 'history', 'logs', 'integrasi', 'docs', 'settings'],
    operator: ['messages', 'testing', 'blast', 'integrasi', 'docs', 'settings'],
};

const DEVICE_ID_RE = /^[A-Za-z0-9_.-]{3,64}$/;

function parsePositiveId(value) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeDeviceId(value) {
    return String(value || '').trim();
}

function isValidDeviceId(value) {
    return DEVICE_ID_RE.test(normalizeDeviceId(value));
}

function normalizeDeviceName(value) {
    const normalized = String(value || '').trim();
    return normalized ? normalized.slice(0, 100) : null;
}

function normalizeAllowedSections(input, role = 'operator') {
    let source = input;
    if (typeof input === 'string') {
        try {
            source = JSON.parse(input);
        } catch {
            source = input.split(',').map(s => s.trim());
        }
    }
    if (!Array.isArray(source) || !source.length) {
        return ROLE_SECTIONS[role] || ROLE_SECTIONS.operator;
    }
    const allowedUniverse = Array.from(new Set(Object.values(ROLE_SECTIONS).flat()));
    const normalized = [...new Set(source.map(v => String(v || '').trim()).filter(v => allowedUniverse.includes(v)))];
    if (normalized.includes('docs') && !normalized.includes('integrasi')) normalized.push('integrasi');
    if (normalized.includes('integrasi') && !normalized.includes('docs')) normalized.push('docs');
    return normalized;
}

function requireAuth(req, res, next) {
    if (!req.session?.authenticated) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session?.authenticated) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    const sessionRole = req.session?.userRole || req.session?.role || req.session?.user?.role || req.session?.type || 'operator';
    const allowedSections = normalizeAllowedSections(req.session?.allowedSections, sessionRole);
    if (!allowedSections.includes('device')) {
        return res.status(403).json({ success: false, message: 'Access denied: device section required' });
    }
    next();
}

function genKey() {
    return crypto.randomBytes(32).toString('hex');
}

function hasStoredSession(deviceId) {
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

// ─── GET /devices ─────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
    try {
        const waService = require('../services/whatsappService');
        const devices = await query('SELECT * FROM devices ORDER BY created_at ASC');
        const enrichedDevices = devices.map((device) => {
            const live = waService.getStatus(device.device_id);
            const hasLiveClient = waService.hasClient(device.device_id);
            return {
                ...device,
                status: hasLiveClient ? live.status : (live.status || 'disconnected'),
                has_session: hasStoredSession(device.device_id),
            };
        });
        res.json({ success: true, data: enrichedDevices });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─── POST /devices — add a device ─────────────────────────────────────────────
router.post('/', requireAdmin, async (req, res) => {
    const deviceId = normalizeDeviceId(req.body?.device_id);
    const name = normalizeDeviceName(req.body?.name);
    const { type } = req.body || {};
    if (!deviceId) {
        return res.status(400).json({ success: false, message: 'device_id is required' });
    }
    if (!isValidDeviceId(deviceId)) {
        return res.status(400).json({ success: false, message: 'Invalid device_id format' });
    }
    const api_key = genKey();
    const deviceType = ['sender','center','none'].includes(type) ? type : 'none';
    try {
        await query(
            'INSERT INTO devices (device_id, name, type, api_key, status, active) VALUES (?, ?, ?, ?, \'disconnected\', 1)',
            [deviceId, name, deviceType, api_key]
        );
        const device = await queryOne('SELECT * FROM devices WHERE device_id = ?', [deviceId]);
        res.json({ success: true, data: device });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, message: 'Device ID already exists' });
        }
        res.status(500).json({ success: false, message: 'Failed to create device' });
    }
});

// ─── PATCH /devices/:id/active — toggle active ─────────────────────────────
router.patch('/:id/active', requireAdmin, async (req, res) => {
    const deviceRowId = parsePositiveId(req.params.id);
    if (!deviceRowId) return res.status(400).json({ success: false, message: 'Invalid device id' });
    const { active } = req.body;
    try {
        await query('UPDATE devices SET active = ?, updated_at = NOW() WHERE id = ?', [active ? 1 : 0, deviceRowId]);
        const device = await queryOne('SELECT * FROM devices WHERE id = ?', [deviceRowId]);
        if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
        res.json({ success: true, data: device });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update device status' });
    }
});

// ─── PATCH /devices/:id/incoming-ack — toggle incoming ack reply ────────────
router.patch('/:id/incoming-ack', requireAdmin, async (req, res) => {
    const deviceRowId = parsePositiveId(req.params.id);
    if (!deviceRowId) return res.status(400).json({ success: false, message: 'Invalid device id' });
    const { incoming_ack_reply_enabled } = req.body;
    try {
        await query(
            'UPDATE devices SET incoming_ack_reply_enabled = ?, updated_at = NOW() WHERE id = ?',
            [incoming_ack_reply_enabled ? 1 : 0, deviceRowId]
        );
        const device = await queryOne('SELECT * FROM devices WHERE id = ?', [deviceRowId]);
        if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
        const waService = require('../services/whatsappService');
        waService._devState(device.device_id).incomingAckReplyEnabled = !!device.incoming_ack_reply_enabled;
        res.json({ success: true, data: device });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update incoming ack setting' });
    }
});

// ─── PATCH /devices/:id/webhook-reply-delay — set webhook reply delay ────────
router.patch('/:id/webhook-reply-delay', requireAdmin, async (req, res) => {
    const deviceRowId = parsePositiveId(req.params.id);
    if (!deviceRowId) return res.status(400).json({ success: false, message: 'Invalid device id' });
    const delay = Math.max(0, Math.min(30, parseInt(req.body.webhook_reply_delay) || 0));
    try {
        await query(
            'UPDATE devices SET webhook_reply_delay = ?, updated_at = NOW() WHERE id = ?',
            [delay, deviceRowId]
        );
        const device = await queryOne('SELECT * FROM devices WHERE id = ?', [deviceRowId]);
        if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
        const waService = require('../services/whatsappService');
        waService._devState(device.device_id).webhookReplyDelay = device.webhook_reply_delay || 0;
        res.json({ success: true, data: device });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update webhook reply delay' });
    }
});

// ─── PATCH /devices/:id/type — set device type (sender/center/none) ───────────
router.patch('/:id/type', requireAdmin, async (req, res) => {
    const deviceRowId = parsePositiveId(req.params.id);
    if (!deviceRowId) return res.status(400).json({ success: false, message: 'Invalid device id' });
    const { type } = req.body || {};
    const deviceType = ['sender','center','none'].includes(type) ? type : 'none';
    try {
        await query('UPDATE devices SET type = ?, updated_at = NOW() WHERE id = ?', [deviceType, deviceRowId]);
        const device = await queryOne('SELECT * FROM devices WHERE id = ?', [deviceRowId]);
        if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
        res.json({ success: true, data: device });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update device type' });
    }
});

// ─── PATCH /devices/:id — rename ──────────────────────────────────────────────
router.patch('/:id', requireAdmin, async (req, res) => {
    const deviceRowId = parsePositiveId(req.params.id);
    if (!deviceRowId) return res.status(400).json({ success: false, message: 'Invalid device id' });
    const name = normalizeDeviceName(req.body?.name);
    try {
        await query('UPDATE devices SET name = ?, updated_at = NOW() WHERE id = ?', [name, deviceRowId]);
        const device = await queryOne('SELECT * FROM devices WHERE id = ?', [deviceRowId]);
        if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
        res.json({ success: true, data: device });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update device' });
    }
});

// ─── DELETE /devices/:id ──────────────────────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
    const deviceRowId = parsePositiveId(req.params.id);
    if (!deviceRowId) return res.status(400).json({ success: false, message: 'Invalid device id' });
    try {
        const waService = require('../services/whatsappService');
        const device = await queryOne('SELECT device_id FROM devices WHERE id = ?', [deviceRowId]);
        if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

        await waService.stop(device.device_id).catch(() => {});
        await waService.purgeSessionData(device.device_id, false);

        await query('DELETE FROM message_logs WHERE device_id = ?', [device.device_id]);
        await query('DELETE FROM devices WHERE id = ?', [deviceRowId]);

        res.json({ success: true, message: 'Device deleted' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message || 'Failed to delete device' });
    }
});

// ─── POST /devices/:id/regen-key — regenerate API key ─────────────────────────
router.post('/:id/regen-key', requireAdmin, async (req, res) => {
    const deviceRowId = parsePositiveId(req.params.id);
    if (!deviceRowId) return res.status(400).json({ success: false, message: 'Invalid device id' });
    try {
        const api_key = genKey();
        const result = await query(
            'UPDATE devices SET api_key = ?, updated_at = NOW() WHERE id = ?',
            [api_key, deviceRowId]
        );
        if (!result.affectedRows) {
            return res.status(404).json({ success: false, message: 'Device not found' });
        }
        res.json({ success: true, data: { api_key } });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to regenerate API key' });
    }
});

module.exports = router;
