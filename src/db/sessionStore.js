const session = require('express-session');
const { getPool } = require('./database');

class MySQLSessionStore extends session.Store {
    constructor(options = {}) {
        super(options);
        this._cleanupInterval = setInterval(() => this._cleanup(), 15 * 60 * 1000); // every 15 min
    }

    async get(sid, callback) {
        try {
            const pool = await getPool();
            const [rows] = await pool.execute(
                'SELECT data FROM sessions WHERE session_id = ? AND expires > ?',
                [sid, Date.now()]
            );
            if (rows.length && rows[0].data) {
                callback(null, JSON.parse(rows[0].data));
            } else {
                callback(null, null);
            }
        } catch (err) {
            callback(err);
        }
    }

    async set(sid, sessionData, callback) {
        try {
            const pool = await getPool();
            const maxAge = sessionData?.cookie?.maxAge || 7 * 24 * 60 * 60 * 1000;
            const expires = Date.now() + maxAge;
            const data = JSON.stringify(sessionData);
            await pool.execute(
                'REPLACE INTO sessions (session_id, expires, data) VALUES (?, ?, ?)',
                [sid, expires, data]
            );
            callback(null);
        } catch (err) {
            callback(err);
        }
    }

    async destroy(sid, callback) {
        try {
            const pool = await getPool();
            await pool.execute('DELETE FROM sessions WHERE session_id = ?', [sid]);
            callback(null);
        } catch (err) {
            callback(err);
        }
    }

    async touch(sid, sessionData, callback) {
        try {
            const pool = await getPool();
            const maxAge = sessionData?.cookie?.maxAge || 7 * 24 * 60 * 60 * 1000;
            const expires = Date.now() + maxAge;
            await pool.execute(
                'UPDATE sessions SET expires = ? WHERE session_id = ?',
                [expires, sid]
            );
            callback(null);
        } catch (err) {
            callback(err);
        }
    }

    async _cleanup() {
        try {
            const pool = await getPool();
            await pool.execute('DELETE FROM sessions WHERE expires <= ?', [Date.now()]);
        } catch {}
    }

    close() {
        if (this._cleanupInterval) clearInterval(this._cleanupInterval);
    }
}

module.exports = MySQLSessionStore;
