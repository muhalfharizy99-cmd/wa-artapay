const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne } = require('../db/database');
const config = require('../config/config');

class WebhookService {

    _normalizeUrl(url) {
        return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
    }

    // ─── CRUD ─────────────────────────────────────────────────────────────────

    async add(url, events = ['message'], description = '', deviceId) {
        const targetDeviceId = String(deviceId || '').trim();
        if (!targetDeviceId) throw new Error('device_id is required');
        const existing = await queryOne(
            'SELECT * FROM webhooks WHERE device_id = ?',
            [targetDeviceId]
        );
        if (existing) {
            await query(
                'UPDATE webhooks SET url = ?, events = ?, description = ?, updated_at = NOW() WHERE id = ?',
                [url, JSON.stringify(events), description, existing.id]
            );
            const updated = await queryOne('SELECT * FROM webhooks WHERE id = ?', [existing.id]);
            return this._format(updated);
        }
        const id = uuidv4();
        await query(
            'INSERT INTO webhooks (id, device_id, url, events, description) VALUES (?, ?, ?, ?, ?)',
            [id, targetDeviceId, url, JSON.stringify(events), description || null]
        );
        const wh = await queryOne('SELECT * FROM webhooks WHERE id = ?', [id]);
        return this._format(wh);
    }

    async remove(id) {
        const result = await query('DELETE FROM webhooks WHERE id = ?', [id]);
        return result.affectedRows > 0;
    }

    async toggle(id, active) {
        await query('UPDATE webhooks SET active = ?, updated_at = NOW() WHERE id = ?', [active ? 1 : 0, id]);
        const wh = await queryOne('SELECT * FROM webhooks WHERE id = ?', [id]);
        return wh ? this._format(wh) : null;
    }

    async list(deviceId = null) {
        let rows;
        if (deviceId) {
            rows = await query(
                'SELECT * FROM webhooks WHERE device_id = ? ORDER BY created_at DESC',
                [deviceId]
            );
        } else {
            rows = await query('SELECT * FROM webhooks ORDER BY created_at DESC');
        }
        return rows.map(r => this._format(r));
    }

    async get(id) {
        const wh = await queryOne('SELECT * FROM webhooks WHERE id = ?', [id]);
        return wh ? this._format(wh) : null;
    }

    // ─── Dispatch ─────────────────────────────────────────────────────────────
    // deviceId: the device that triggered the event

    async dispatch(event, payload, deviceId) {
        try {
            const normalizedDeviceId = String(deviceId || '').trim();
            if (!normalizedDeviceId) return [];
            const targets = await query(
                `SELECT * FROM webhooks
                 WHERE active = 1
                   AND device_id = ?
                   AND (JSON_CONTAINS(events, ?) OR JSON_CONTAINS(events, '"*"'))
                 ORDER BY created_at DESC`,
                [normalizedDeviceId, JSON.stringify(event)]
            );
            if (!targets.length) return [];

            const results = await Promise.allSettled(
                targets.map(wh => this._send(this._format(wh), event, payload, normalizedDeviceId))
            );
            return results;
        } catch (err) {
            console.error(`[WEBHOOK] Dispatch failed for event '${event}' on device '${deviceId}': ${err.message}`);
            return [{ status: 'rejected', reason: err.message }];
        }
    }

    async _send(webhook, event, payload, deviceId) {
        const payloadId = payload?.id || payload?.messageId || payload?.msg_id || null;
        const baseIdempotencyKey = payloadId
            ? `${deviceId}:${event}:${payloadId}`
            : `${deviceId}:${event}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

        // Get device type to determine role
        const { queryOne } = require('../db/database');
        const device = await queryOne('SELECT type FROM devices WHERE device_id = ? LIMIT 1', [deviceId]);
        const deviceType = device?.type || 'none';
        const role = deviceType === 'sender' ? 'SENDER' : deviceType === 'center' ? 'CENTER' : null;

        const body = {
            event,
            device_id: deviceId,
            timestamp: new Date().toISOString(),
            data: payload,
            meta: {
                idempotency_key: baseIdempotencyKey,
                payload_id: payloadId,
                role: role,
            },
        };

        const headers = {
            'Content-Type': 'application/json',
            'X-WA-Event': event,
            'X-WA-Device': deviceId,
            'X-WA-Idempotency-Key': baseIdempotencyKey,
        };
        if (payloadId) headers['X-WA-Message-ID'] = String(payloadId);
        if (webhook.secret) {
            const crypto = require('crypto');
            headers['X-WA-Signature'] = crypto
                .createHmac('sha256', webhook.secret)
                .update(JSON.stringify(body))
                .digest('hex');
        }

        // Add role to URL query string
        let webhookUrl = webhook.url;
        if (role) {
            const urlObj = new URL(webhookUrl);
            urlObj.searchParams.set('role', role);
            webhookUrl = urlObj.toString();
        }

        const start = Date.now();
        let attempt = 0;
        const maxRetry = Number.isFinite(config.webhook.retry) && config.webhook.retry > 0 ? config.webhook.retry : 3;
        const timeoutMs = Number.isFinite(config.webhook.timeout) && config.webhook.timeout > 0 ? config.webhook.timeout : 10000;

        while (attempt < maxRetry) {
            try {
                const res = await axios.post(webhookUrl, body, {
                    timeout: timeoutMs,
                    headers: {
                        ...headers,
                        'X-WA-Attempt': String(attempt + 1),
                    },
                });
                const duration = Date.now() - start;
                await query(
                    `UPDATE webhooks SET stat_sent = stat_sent + 1, last_sent = NOW(), updated_at = NOW() WHERE id = ?`,
                    [webhook.id]
                ).catch(() => {});
                await query(
                    `INSERT INTO webhook_logs (webhook_id, device_id, event, payload, success, status_code, duration_ms) VALUES (?,?,?,?,1,?,?)`,
                    [webhook.id, deviceId, event, JSON.stringify(body), res.status, duration]
                ).catch(() => {});
                return { webhook: webhook.id, success: true, status: res.status, data: res.data };
            } catch (err) {
                attempt++;
                const errorMessage = err.response?.data?.message || err.response?.data?.error || err.message;
                if (attempt >= maxRetry) {
                    const duration = Date.now() - start;
                    await query(
                        `UPDATE webhooks SET stat_failed = stat_failed + 1, updated_at = NOW() WHERE id = ?`,
                        [webhook.id]
                    ).catch(() => {});
                    await query(
                        `INSERT INTO webhook_logs (webhook_id, device_id, event, payload, success, error, duration_ms) VALUES (?,?,?,?,0,?,?)`,
                        [webhook.id, deviceId, event, JSON.stringify(body), errorMessage, duration]
                    ).catch(() => {});
                    console.error(`[WEBHOOK] Failed POST ${webhook.url} (${event}/${deviceId}): ${errorMessage}`);
                    return { webhook: webhook.id, success: false, error: errorMessage, data: err.response?.data || null };
                }
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }
    }

    _format(row) {
        if (!row) return null;
        return {
            id:          row.id,
            device_id:   row.device_id,
            url:         row.url,
            events:      typeof row.events === 'string' ? JSON.parse(row.events) : row.events,
            description: row.description,
            secret:      row.secret,
            active:      !!row.active,
            stats: {
                sent:    row.stat_sent   || 0,
                failed:  row.stat_failed || 0,
                lastSent: row.last_sent  || null,
            },
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
}

module.exports = new WebhookService();
