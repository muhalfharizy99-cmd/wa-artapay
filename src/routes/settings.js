const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db/database');

const ROLE_SECTIONS = {
    admin: ['dashboard', 'device', 'messages', 'testing', 'blast', 'history', 'logs', 'integrasi', 'docs', 'users', 'settings'],
    cs: ['messages', 'testing', 'blast', 'history', 'logs', 'integrasi', 'docs', 'settings'],
    operator: ['messages', 'testing', 'blast', 'integrasi', 'docs', 'settings'],
};

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

function requireSession(req, res, next) {
    if (!req.session?.authenticated) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session?.authenticated) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    const role = req.session.userRole || 'operator';
    const allowedSections = normalizeAllowedSections(req.session.allowedSections, role);
    if (!allowedSections.includes('settings')) {
        return res.status(403).json({ success: false, message: 'Access denied: settings section required' });
    }
    next();
}

router.get('/settings', requireSession, async (req, res) => {
    try {
        const row = await queryOne('SELECT setting_value FROM app_settings WHERE setting_key = ?', ['blast_cron_token']);
        const cronToken = row?.setting_value || process.env.CRON_TOKEN || '';
        res.json({ success: true, data: { blast_cron_token: cronToken } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.patch('/settings', requireAdmin, async (req, res) => {
    try {
        const { blast_cron_token } = req.body;
        const token = String(blast_cron_token || '').trim();
        if (!token) {
            return res.status(400).json({ success: false, message: 'blast_cron_token is required' });
        }
        if (token.length > 255) {
            return res.status(400).json({ success: false, message: 'blast_cron_token max length is 255' });
        }

        await query(
            'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
            ['blast_cron_token', token]
        );

        res.json({ success: true, data: { blast_cron_token: token } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
