const express = require('express');
const router = express.Router();
const { apiKeyAuth } = require('../middleware/auth');
const { query, queryOne } = require('../db/database');
const waService = require('../services/whatsappService');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const upload = multer({ storage: multer.memoryStorage() });

const BLAST_UPLOAD_DIR = path.resolve(process.cwd(), 'public', 'assets', 'blast');

function blastAuth(req, res, next) {
    if (req.session?.authenticated) return next();
    return apiKeyAuth(req, res, next);
}

function ensureBlastUploadDir() {
    if (!fs.existsSync(BLAST_UPLOAD_DIR)) fs.mkdirSync(BLAST_UPLOAD_DIR, { recursive: true });
}

function buildPublicMediaUrl(req, fileName) {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    return `${baseUrl}/assets/blast/${fileName}`;
}

// Helper: Format phone number
function formatPhone(phone) {
    const cleaned = phone.toString().trim().replace(/\D/g, '');
    if (cleaned.startsWith('0')) return '62' + cleaned.slice(1);
    if (cleaned.startsWith('+')) return cleaned.slice(1);
    return cleaned;
}

// Helper: Validate phone format (62xxx)
function isValidPhone(phone) {
    return /^62\d{9,13}$/.test(phone);
}

function normalizeScheduleAt(input) {
    if (!input) return null;
    const raw = String(input).trim();
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s = '00'] = m;
    return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

function getCurrentLocalDateTimeString() {
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

function parseIdList(input) {
    if (!input) return [];
    let source = input;

    if (typeof input === 'string') {
        try {
            source = JSON.parse(input);
        } catch {
            source = input.split(',').map(s => s.trim());
        }
    }

    if (!Array.isArray(source)) return [];

    const out = [];
    const seen = new Set();
    for (const raw of source) {
        const n = Number.parseInt(raw, 10);
        if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
    }
    return out;
}

function parsePhoneList(input) {
    if (!input) return [];
    let source = input;

    if (typeof input === 'string') {
        try {
            source = JSON.parse(input);
        } catch {
            source = input.split(/\r?\n|,/).map(s => s.trim());
        }
    }

    if (!Array.isArray(source)) return [];

    const seen = new Set();
    const out = [];
    for (const item of source) {
        const phone = String(item || '').trim();
        if (!isValidPhone(phone) || seen.has(phone)) continue;
        seen.add(phone);
        out.push(phone);
    }
    return out;
}

function buildCampaignTargetCondition(campaign, params, alias = 'c') {
    const clauses = [];
    const normalizedDeviceId = typeof campaign.device_id === 'string' ? campaign.device_id.trim() : campaign.device_id;

    if (normalizedDeviceId && normalizedDeviceId !== '*') {
        clauses.push(`(${alias}.device_id = ? OR ${alias}.device_id = ?)`);
        params.push(normalizedDeviceId, '*');
    }

    if (campaign.target_type === 'group') {
        const gid = Number.parseInt(campaign.target_group_id, 10);
        if (!Number.isFinite(gid) || gid <= 0) return ' AND 1=0';
        clauses.push(`${alias}.group_id = ?`);
        params.push(gid);
    }

    if (campaign.target_type === 'manual') {
        const manualPhones = parsePhoneList(campaign.target_contact_ids);
        if (!manualPhones.length) return ' AND 1=0';
        clauses.push(`${alias}.phone IN (${manualPhones.map(() => '?').join(',')})`);
        params.push(...manualPhones);
    }

    if (!clauses.length) return '';
    return ` AND ${clauses.join(' AND ')}`;
}

async function countCampaignTargetContacts(campaign) {
    if (campaign.target_type === 'manual') {
        return parsePhoneList(campaign.target_contact_ids).length;
    }
    const countParams = [];
    const targetFilter = buildCampaignTargetCondition(campaign, countParams, 'c');
    const [{ cnt }] = await query(
        `SELECT COUNT(*) as cnt FROM blast_contacts c WHERE c.active = 1${targetFilter}`,
        countParams
    );
    return Number(cnt || 0);
}

// ─── BLAST CONTACTS ────────────────────────────────────────────────────────

// Contact groups list
router.get('/blast/groups', blastAuth, async (req, res) => {
    try {
        const { device_id } = req.query;
        let sql = `SELECT g.id, g.name, g.device_id, g.created_at,
                          COUNT(c.id) as total_contacts,
                          SUM(CASE WHEN c.active = 1 THEN 1 ELSE 0 END) as active_contacts
                   FROM blast_contact_groups g
                   LEFT JOIN blast_contacts c ON c.group_id = g.id`;
        const params = [];
        const normalizedDeviceId = typeof device_id === 'string' ? device_id.trim() : device_id;

        if (normalizedDeviceId && normalizedDeviceId !== '*') {
            sql += ' WHERE g.device_id = ? OR g.device_id = ?';
            params.push(normalizedDeviceId, '*');
        }

        sql += ' GROUP BY g.id ORDER BY g.created_at DESC';
        const rows = await query(sql, params);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Add contact group
router.post('/blast/groups', blastAuth, async (req, res) => {
    try {
        const { name, device_id = '*' } = req.body;
        const groupName = String(name || '').trim();
        const normalizedDeviceId = String(device_id || '*').trim() || '*';

        if (!groupName) {
            return res.status(400).json({ success: false, message: 'Group name required' });
        }

        const result = await query(
            'INSERT INTO blast_contact_groups (name, device_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)',
            [groupName, normalizedDeviceId]
        );

        res.json({ success: true, data: { id: result.insertId || null, name: groupName, device_id: normalizedDeviceId } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Delete contact group
router.delete('/blast/groups/:id', blastAuth, async (req, res) => {
    try {
        const groupId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(groupId) || groupId <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid group id' });
        }

        await query('UPDATE blast_contacts SET group_id = NULL WHERE group_id = ?', [groupId]);
        await query('DELETE FROM blast_contact_groups WHERE id = ?', [groupId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Get all contacts
router.get('/blast/contacts', blastAuth, async (req, res) => {
    try {
        const { device_id, search, limit = 1000 } = req.query;
        let sql = `SELECT c.*, g.name as group_name
                   FROM blast_contacts c
                   LEFT JOIN blast_contact_groups g ON c.group_id = g.id
                   WHERE 1=1`;
        const params = [];
        const normalizedDeviceId = typeof device_id === 'string' ? device_id.trim() : device_id;
        const parsedLimit = Number.parseInt(limit, 10);
        const safeLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 5000) : 1000;
        
        if (normalizedDeviceId && normalizedDeviceId !== '*') {
            sql += ' AND c.device_id = ?';
            params.push(normalizedDeviceId);
        }
        
        if (search) {
            sql += ' AND (c.name LIKE ? OR c.phone LIKE ? OR g.name LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
            params.push(`%${search}%`);
        }
        
        sql += ` ORDER BY c.created_at DESC LIMIT ${safeLimit}`;
        
        const rows = await query(sql, params);
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Add single contact
router.post('/blast/contacts', blastAuth, async (req, res) => {
    try {
        const { name, phone, device_id = '*', group_id = null } = req.body;
        if (!phone) return res.status(400).json({ success: false, message: 'Phone required' });
        
        const formattedPhone = formatPhone(phone);
        const parsedGroupId = Number.parseInt(group_id, 10);
        const safeGroupId = Number.isFinite(parsedGroupId) && parsedGroupId > 0 ? parsedGroupId : null;
        if (!isValidPhone(formattedPhone)) {
            return res.status(400).json({ success: false, message: 'Invalid phone format. Use 62xxx' });
        }
        
        const result = await query(
            'INSERT INTO blast_contacts (name, phone, device_id, group_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), group_id=VALUES(group_id), active=1',
            [name || null, formattedPhone, device_id, safeGroupId]
        );
        
        res.json({ success: true, data: { id: result.insertId, phone: formattedPhone } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Import contacts from CSV/Excel
router.post('/blast/contacts/import', blastAuth, upload.single('file'), async (req, res) => {
    try {
        const { device_id = '*', group_id = null } = req.body;
        if (!req.file) return res.status(400).json({ success: false, message: 'File required' });
        const parsedGroupId = Number.parseInt(group_id, 10);
        const safeGroupId = Number.isFinite(parsedGroupId) && parsedGroupId > 0 ? parsedGroupId : null;
        
        const content = req.file.buffer.toString('utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        
        const imported = [];
        const failed = [];
        
        for (const line of lines) {
            const parts = line.split(',').map(p => p.trim());
            if (parts.length < 1) continue;
            
            const name = parts[0] || '';
            const phone = formatPhone(parts[1] || parts[0]);
            
            if (!isValidPhone(phone)) {
                failed.push({ name, phone, reason: 'Invalid format' });
                continue;
            }
            
            try {
                await query(
                    'INSERT INTO blast_contacts (name, phone, device_id, group_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name=VALUES(name), group_id=VALUES(group_id), active=1',
                    [name || null, phone, device_id, safeGroupId]
                );
                imported.push({ name, phone });
            } catch (e) {
                failed.push({ name, phone, reason: e.message });
            }
        }
        
        res.json({ 
            success: true, 
            data: { imported: imported.length, failed: failed.length, failed_details: failed }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Export contacts to CSV
router.get('/blast/contacts/export', blastAuth, async (req, res) => {
    try {
        const { device_id, group_id } = req.query;
        let sql = 'SELECT name, phone, device_id, active, created_at FROM blast_contacts WHERE 1=1';
        const params = [];
        const normalizedDeviceId = typeof device_id === 'string' ? device_id.trim() : device_id;
        const normalizedGroupId = typeof group_id === 'string' ? group_id.trim() : group_id;
        
        if (normalizedDeviceId && normalizedDeviceId !== '*') {
            sql += ' AND device_id = ?';
            params.push(normalizedDeviceId);
        }

        if (normalizedGroupId === 'ungrouped') {
            sql += ' AND (group_id IS NULL OR group_id = 0)';
        } else {
            const parsedGroupId = Number.parseInt(normalizedGroupId, 10);
            if (Number.isFinite(parsedGroupId) && parsedGroupId > 0) {
                sql += ' AND group_id = ?';
                params.push(parsedGroupId);
            }
        }
        
        sql += ' ORDER BY created_at DESC';
        const rows = await query(sql, params);
        
        let csv = 'Name,Phone\n';
        for (const row of rows) {
            csv += `"${row.name || ''}","${row.phone}"\n`;
        }
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="blast-contacts.csv"');
        res.send(csv);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Delete contact
router.delete('/blast/contacts/:id', blastAuth, async (req, res) => {
    try {
        await query('DELETE FROM blast_contacts WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Toggle contact active status
router.patch('/blast/contacts/:id/toggle', blastAuth, async (req, res) => {
    try {
        const { active } = req.body;
        await query('UPDATE blast_contacts SET active = ? WHERE id = ?', [active ? 1 : 0, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Assign contact to group
router.patch('/blast/contacts/:id/group', blastAuth, async (req, res) => {
    try {
        const parsedGroupId = Number.parseInt(req.body?.group_id, 10);
        const safeGroupId = Number.isFinite(parsedGroupId) && parsedGroupId > 0 ? parsedGroupId : null;
        await query('UPDATE blast_contacts SET group_id = ? WHERE id = ?', [safeGroupId, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─── BLAST CAMPAIGNS ────────────────────────────────────────────────────────

router.post('/blast/media/upload', blastAuth, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, message: 'File required' });

        ensureBlastUploadDir();
        const safeExt = path.extname(req.file.originalname || '').replace(/[^a-zA-Z0-9.]/g, '') || '.bin';
        const fileName = `blast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${safeExt}`;
        const targetPath = path.join(BLAST_UPLOAD_DIR, fileName);
        fs.writeFileSync(targetPath, req.file.buffer);

        res.json({
            success: true,
            data: {
                file_name: fileName,
                media_url: buildPublicMediaUrl(req, fileName),
                mime_type: req.file.mimetype || null,
                size: req.file.size || 0,
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Get all campaigns
router.get('/blast/campaigns', blastAuth, async (req, res) => {
    try {
        const { device_id } = req.query;
        let sql = `SELECT bc.*, g.name as target_group_name
                   FROM blast_campaigns bc
                   LEFT JOIN blast_contact_groups g ON bc.target_group_id = g.id
                   WHERE 1=1`;
        const params = [];
        const normalizedDeviceId = typeof device_id === 'string' ? device_id.trim() : device_id;
        
        if (normalizedDeviceId && normalizedDeviceId !== '*') {
            sql += ' AND bc.device_id = ?';
            params.push(normalizedDeviceId);
        }
        
        sql += ' ORDER BY bc.created_at DESC';
        const rows = await query(sql, params);
        const data = rows.map(row => ({
            ...row,
            target_contact_ids: parseIdList(row.target_contact_ids),
        }));
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Create campaign
router.post('/blast/campaigns', blastAuth, async (req, res) => {
    try {
        const {
            name,
            message,
            media_url,
            caption,
            device_id = '*',
            delay_ms = 2000,
            schedule_at,
            target_type = 'all',
            target_group_id = null,
            manual_contact_ids = [],
        } = req.body;
        
        if (!name) return res.status(400).json({ success: false, message: 'Campaign name required' });
        const safeTargetType = ['all', 'group', 'manual'].includes(String(target_type)) ? String(target_type) : 'all';
        const parsedGroupId = Number.parseInt(target_group_id, 10);
        const safeTargetGroupId = Number.isFinite(parsedGroupId) && parsedGroupId > 0 ? parsedGroupId : null;
        const safeManualPhones = parsePhoneList(manual_contact_ids);

        if (safeTargetType === 'group' && !safeTargetGroupId) {
            return res.status(400).json({ success: false, message: 'Group target required' });
        }

        if (safeTargetType === 'manual' && !safeManualPhones.length) {
            return res.status(400).json({ success: false, message: 'Manual contacts required' });
        }
        
        if (typeof media_url === 'string' && media_url.startsWith('data:')) {
            return res.status(400).json({
                success: false,
                message: 'media_url tidak boleh data URL. Upload file lokal via /api/blast/media/upload',
            });
        }

        // Count total contacts for this device
        const cnt = await countCampaignTargetContacts({
            device_id,
            target_type: safeTargetType,
            target_group_id: safeTargetGroupId,
            target_contact_ids: safeTargetType === 'manual' ? JSON.stringify(safeManualPhones) : null,
        });
        
        const scheduleAt = normalizeScheduleAt(schedule_at);
        if (schedule_at && !scheduleAt) {
            return res.status(400).json({ success: false, message: 'Invalid schedule_at format' });
        }

        const result = await query(
            'INSERT INTO blast_campaigns (name, message, media_url, caption, device_id, delay_ms, schedule_at, target_type, target_group_id, target_contact_ids, total_contacts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                name,
                message || null,
                media_url || null,
                caption || null,
                device_id,
                delay_ms,
                scheduleAt,
                safeTargetType,
                safeTargetGroupId,
                safeTargetType === 'manual' ? JSON.stringify(safeManualPhones) : null,
                cnt,
            ]
        );
        
        res.json({ success: true, data: { id: result.insertId, total_contacts: cnt } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Update campaign
router.patch('/blast/campaigns/:id', blastAuth, async (req, res) => {
    try {
        const { name, message, media_url, caption, delay_ms, status, schedule_at } = req.body;
        const updates = [];
        const params = [];
        
        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (message !== undefined) { updates.push('message = ?'); params.push(message); }
        if (media_url !== undefined) { updates.push('media_url = ?'); params.push(media_url); }
        if (caption !== undefined) { updates.push('caption = ?'); params.push(caption); }
        if (delay_ms !== undefined) { updates.push('delay_ms = ?'); params.push(delay_ms); }
        if (status !== undefined) { updates.push('status = ?'); params.push(status); }
        if (schedule_at !== undefined) {
            const scheduleAt = normalizeScheduleAt(schedule_at);
            if (schedule_at && !scheduleAt) {
                return res.status(400).json({ success: false, message: 'Invalid schedule_at format' });
            }
            updates.push('schedule_at = ?');
            params.push(scheduleAt);
        }
        
        if (updates.length === 0) return res.status(400).json({ success: false, message: 'No fields to update' });
        
        params.push(req.params.id);
        await query(`UPDATE blast_campaigns SET ${updates.join(', ')} WHERE id = ?`, params);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Delete campaign
router.delete('/blast/campaigns/:id', blastAuth, async (req, res) => {
    try {
        await query('DELETE FROM blast_logs WHERE campaign_id = ?', [req.params.id]);
        await query('DELETE FROM blast_campaigns WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Get campaign logs
router.get('/blast/campaigns/:id/logs', blastAuth, async (req, res) => {
    try {
        const rows = await query(
            'SELECT l.*, c.name as contact_name FROM blast_logs l LEFT JOIN blast_contacts c ON l.contact_id = c.id WHERE l.campaign_id = ? ORDER BY l.created_at DESC',
            [req.params.id]
        );
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─── PUBLIC CRON ENDPOINT ───────────────────────────────────────────────────

// Public cron endpoint - run pending campaigns (no auth required, uses secret token)
router.get('/cron/blast', async (req, res) => {
    try {
        const { token, limit = 10 } = req.query;
        const parsedLimit = Number.parseInt(limit, 10);
        const safeLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 10;
        const nowLocal = getCurrentLocalDateTimeString();
        
        // Simple token protection (set in .env)
        const tokenRow = await queryOne('SELECT setting_value FROM app_settings WHERE setting_key = ?', ['blast_cron_token']);
        const CRON_TOKEN = tokenRow?.setting_value || process.env.CRON_TOKEN || 'default-cron-token-change-this';
        if (token !== CRON_TOKEN) {
            return res.status(401).json({ success: false, message: 'Invalid token' });
        }
        
        // Get running campaigns or campaigns ready to run
        const campaigns = await query(
            `SELECT * FROM blast_campaigns 
             WHERE status IN ('running', 'draft') 
             AND (schedule_at IS NULL OR schedule_at <= ?)
             ORDER BY updated_at ASC
             LIMIT ${safeLimit}`,
            [nowLocal]
        );
        
        const results = [];
        
        for (const campaign of campaigns) {
            const result = await processCampaign(campaign, safeLimit);
            results.push(result);
        }

        const summary = results.reduce((acc, item) => {
            acc.sent += item.sent || 0;
            acc.failed += item.failed || 0;
            acc.remaining += item.remaining || 0;
            return acc;
        }, { sent: 0, failed: 0, remaining: 0 });

        const message = campaigns.length
            ? `Eksekusi berhasil. Diproses ${campaigns.length} campaign, sent ${summary.sent}, failed ${summary.failed}, remaining ${summary.remaining}.`
            : 'Eksekusi berhasil. Tidak ada campaign yang siap dijalankan.';
        
        res.json({
            success: true,
            message,
            data: {
                limit: safeLimit,
                processed_campaigns: campaigns.length,
                summary,
                results,
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Internal: Process a campaign (send messages)
async function processCampaign(campaign, batchSize = 10) {
    const { id, device_id, message, media_url, caption, delay_ms } = campaign;
    const parsedBatchSize = Number.parseInt(batchSize, 10);
    const safeBatchSize = Number.isFinite(parsedBatchSize) ? Math.min(Math.max(parsedBatchSize, 1), 500) : 10;
    const totalContacts = await countCampaignTargetContacts(campaign);
    const manualPhones = campaign.target_type === 'manual' ? parsePhoneList(campaign.target_contact_ids) : [];

    await query('UPDATE blast_campaigns SET total_contacts = ? WHERE id = ?', [totalContacts, id]);

    if (totalContacts === 0) {
        await query('UPDATE blast_campaigns SET status = ?, last_run_at = NOW() WHERE id = ?', ['completed', id]);
        return { campaign_id: id, status: 'completed', sent: 0, failed: 0, remaining: 0, total_contacts: 0 };
    }
    
    // Update status to running
    await query('UPDATE blast_campaigns SET status = ?, last_run_at = NOW() WHERE id = ?', ['running', id]);

    let pendingContacts = [];
    if (campaign.target_type === 'manual') {
        const placeholders = manualPhones.map(() => '?').join(',');
        const rows = await query(
            `SELECT phone, status FROM blast_logs WHERE campaign_id = ? AND phone IN (${placeholders})`,
            [id, ...manualPhones]
        );
        const sentPhones = new Set(rows.filter(row => row.status === 'sent').map(row => String(row.phone || '').trim()));
        const pendingPhones = manualPhones.filter(phone => !sentPhones.has(phone)).slice(0, safeBatchSize);
        pendingContacts = pendingPhones.map(phone => ({ id: null, phone }));
    } else {
        const pendingSql = `SELECT c.* FROM blast_contacts c
         LEFT JOIN blast_logs l ON c.id = l.contact_id AND l.campaign_id = ?
         WHERE c.active = 1 AND (l.status IS NULL OR l.status = 'pending')`;
        const pendingParams = [id];
        const pendingFilter = buildCampaignTargetCondition(campaign, pendingParams, 'c');
        pendingContacts = await query(`${pendingSql}${pendingFilter} LIMIT ${safeBatchSize}`, pendingParams);
    }
    
    if (pendingContacts.length === 0) {
        // Check if all done
        let pending = 0;
        if (campaign.target_type === 'manual') {
            const [{ processed }] = await query(
                'SELECT COUNT(*) as processed FROM blast_logs WHERE campaign_id = ? AND status IN (?, ?)',
                [id, 'sent', 'failed']
            );
            pending = Math.max(0, totalContacts - Number(processed || 0));
        } else {
            const result = await query(
                'SELECT COUNT(*) as pending FROM blast_logs WHERE campaign_id = ? AND status = ?',
                [id, 'pending']
            );
            pending = Number(result?.[0]?.pending || 0);
        }
        
        if (pending === 0) {
            await query('UPDATE blast_campaigns SET status = ? WHERE id = ?', ['completed', id]);
            return { campaign_id: id, status: 'completed', sent: 0 };
        }
        return { campaign_id: id, status: 'no_contacts', sent: 0 };
    }
    
    let sent = 0;
    let failed = 0;
    
    for (const contact of pendingContacts) {
        try {
            // Format phone to JID
            const chatId = `${contact.phone}@c.us`;
            
            // Check if already logged for this campaign
            const [existing] = campaign.target_type === 'manual'
                ? await query(
                    'SELECT id, status FROM blast_logs WHERE campaign_id = ? AND phone = ?',
                    [id, contact.phone]
                )
                : await query(
                    'SELECT id, status FROM blast_logs WHERE campaign_id = ? AND contact_id = ?',
                    [id, contact.id]
                );
            
            if (!existing) {
                // Create log entry
                if (campaign.target_type === 'manual') {
                    await query(
                        'INSERT INTO blast_logs (campaign_id, contact_id, phone, status) VALUES (?, ?, ?, ?)',
                        [id, null, contact.phone, 'pending']
                    );
                } else {
                    await query(
                        'INSERT INTO blast_logs (campaign_id, contact_id, phone, status) VALUES (?, ?, ?, ?)',
                        [id, contact.id, contact.phone, 'pending']
                    );
                }
            } else if (existing.status === 'sent') {
                continue; // Already sent
            }
            
            // Send message
            const blastDeviceId = (device_id && device_id !== '*') ? device_id : null;
            if (media_url) {
                const mergedCaption = [caption, message].map(v => String(v || '').trim()).filter(Boolean).join('\n\n');
                await waService.sendMedia(chatId, media_url, mergedCaption, null, {}, blastDeviceId);
            } else if (message) {
                await waService.sendText(chatId, message, {}, blastDeviceId);
            }
            
            // Mark as sent
            if (campaign.target_type === 'manual') {
                await query(
                    'UPDATE blast_logs SET status = ?, sent_at = NOW() WHERE campaign_id = ? AND phone = ?',
                    ['sent', id, contact.phone]
                );
            } else {
                await query(
                    'UPDATE blast_logs SET status = ?, sent_at = NOW() WHERE campaign_id = ? AND contact_id = ?',
                    ['sent', id, contact.id]
                );
            }
            
            // Update campaign stats
            await query('UPDATE blast_campaigns SET sent_count = sent_count + 1 WHERE id = ?', [id]);
            
            sent++;
            
            // Delay between messages
            if (delay_ms > 0 && pendingContacts.length > 1) {
                await new Promise(r => setTimeout(r, delay_ms));
            }
            
        } catch (error) {
            // Mark as failed
            if (campaign.target_type === 'manual') {
                await query(
                    'UPDATE blast_logs SET status = ?, error_msg = ? WHERE campaign_id = ? AND phone = ?',
                    ['failed', error.message.substring(0, 255), id, contact.phone]
                );
            } else {
                await query(
                    'UPDATE blast_logs SET status = ?, error_msg = ? WHERE campaign_id = ? AND contact_id = ?',
                    ['failed', error.message.substring(0, 255), id, contact.id]
                );
            }
            
            // Update campaign stats
            await query('UPDATE blast_campaigns SET failed_count = failed_count + 1 WHERE id = ?', [id]);
            
            failed++;
        }
    }
    
    // Check if completed
    let remaining = 0;
    if (campaign.target_type === 'manual') {
        const [{ processed }] = await query(
            'SELECT COUNT(*) as processed FROM blast_logs WHERE campaign_id = ? AND status IN (?, ?)',
            [id, 'sent', 'failed']
        );
        remaining = Math.max(0, totalContacts - Number(processed || 0));
    } else {
        const result = await query(
            'SELECT COUNT(*) as remaining FROM blast_logs WHERE campaign_id = ? AND status = ?',
            [id, 'pending']
        );
        remaining = Number(result?.[0]?.remaining || 0);
    }

    const finalStatus = remaining === 0 ? 'completed' : 'running';
    await query('UPDATE blast_campaigns SET status = ? WHERE id = ?', [finalStatus, id]);

    return { 
        campaign_id: id, 
        status: finalStatus,
        sent, 
        failed,
        remaining 
    };
}

// Manual trigger campaign (for testing)
router.post('/blast/campaigns/:id/run', blastAuth, async (req, res) => {
    try {
        const campaign = await queryOne('SELECT * FROM blast_campaigns WHERE id = ?', [req.params.id]);
        if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });
        
        const result = await processCampaign(campaign, 5);
        res.json({ success: true, data: result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
