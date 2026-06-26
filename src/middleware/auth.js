const { queryOne } = require('../db/database');

function normalizeApiKey(value) {
    return String(value || '').trim();
}

async function apiKeyAuth(req, res, next) {
    const key = normalizeApiKey(req.headers['x-api-key']);
    // Logged-in web UI may omit API key, but if a key is provided we must still
    // resolve req.deviceId from that key so requests route to the correct device.
    if (!key) {
        if (req.session?.authenticated) return next();
        return res.status(401).json({ success: false, message: 'Unauthorized: Missing API key' });
    }
    if (!/^[A-Fa-f0-9]{32,128}$/.test(key)) {
        return res.status(401).json({ success: false, message: 'Unauthorized: Invalid API key format' });
    }
    // Per-device key from DB
    try {
        const device = await queryOne(
            'SELECT id, device_id, active FROM devices WHERE api_key = ? AND active = 1',
            [key]
        );
        if (device) {
            req.deviceId = device.device_id;
            return next();
        }
    } catch { /* DB not ready yet — fall through */ }
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid API key' });
}

module.exports = { apiKeyAuth };
