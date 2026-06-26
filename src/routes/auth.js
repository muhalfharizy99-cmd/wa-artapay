const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const { queryOne, query } = require('../db/database');

const ROLES = ['admin', 'cs', 'operator'];
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,64}$/;

function normalizeUsername(value) {
    return String(value || '').trim();
}

function isValidUsername(value) {
    return USERNAME_RE.test(normalizeUsername(value));
}

function isStrongEnoughPassword(value) {
    return typeof value === 'string' && value.length >= 8 && value.length <= 128;
}

function parsePositiveId(value) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

const ROLE_SECTIONS = {
    admin: ['dashboard', 'device', 'messages', 'testing', 'blast', 'history', 'logs', 'integrasi', 'docs', 'users', 'settings'],
    cs: ['messages', 'testing', 'blast', 'history', 'logs', 'integrasi', 'docs', 'settings'],
    operator: ['messages', 'testing', 'blast', 'integrasi', 'docs', 'settings'],
};

function getDefaultSections(role) {
    return ROLE_SECTIONS[role] || ROLE_SECTIONS.operator;
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
        return getDefaultSections(role);
    }
    const allowedUniverse = Array.from(new Set(Object.values(ROLE_SECTIONS).flat()));
    const normalized = [...new Set(source.map(v => String(v || '').trim()).filter(v => allowedUniverse.includes(v)))];
    if (normalized.includes('docs') && !normalized.includes('integrasi')) normalized.push('integrasi');
    if (normalized.includes('integrasi') && !normalized.includes('docs')) normalized.push('docs');
    return normalized;
}

// section → frontend route
const SECTION_ROUTE = {
    dashboard: '/dashboard',
    device:    '/device',
    messages:  '/messages',
    testing:   '/testing',
    blast:     '/blast',
    history:   '/history',
    logs:      '/logs',
    integrasi: '/docs',
    docs:      '/docs',
    users:     '/users',
    settings:  '/settings',
};

function getRedirectForSections(allowedSections) {
    for (const section of allowedSections) {
        if (SECTION_ROUTE[section]) return SECTION_ROUTE[section];
    }
    return '/';
}

// ─── POST /auth/login ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username and password are required' });
    }
    if (!isValidUsername(username)) {
        return res.status(400).json({ success: false, message: 'Invalid username format' });
    }

    try {
        const user = await queryOne(
            'SELECT * FROM users WHERE username = ? AND active = 1 LIMIT 1',
            [username]
        );

        if (!user) {
            return res.status(401).json({ success: false, message: 'Username atau password salah.' });
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(401).json({ success: false, message: 'Username atau password salah.' });
        }

        // Support transition: column may still be named 'type' until migration runs
        const role = user.role || user.type || 'operator';
        if (!ROLES.includes(role)) {
            return res.status(403).json({ success: false, message: 'Akun belum aktif atau role tidak valid. Hubungi administrator.' });
        }

        const allowedSections = normalizeAllowedSections(user.allowed_sections, role);
        const redirect = getRedirectForSections(allowedSections);
        req.session.regenerate((regenErr) => {
            if (regenErr) {
                console.error('[AUTH] Session regenerate error:', regenErr.message);
                return res.status(500).json({ success: false, message: 'Failed to start login session. Please try again.' });
            }
            req.session.authenticated = true;
            req.session.userId        = user.id;
            req.session.username      = user.username;
            req.session.userRole      = role;
            req.session.allowedSections = allowedSections;
            req.session.loginAt       = new Date().toISOString();
            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error('[AUTH] Session save error:', saveErr.message);
                    return res.status(500).json({ success: false, message: 'Failed to save login session. Please try again.' });
                }
                res.json({
                    success: true,
                    message: 'Login berhasil',
                    role,
                    redirect,
                });
            });
        });
    } catch (err) {
        console.error('[AUTH] Login error:', err.message);
        res.status(500).json({ success: false, message: 'Database error. Please try again.' });
    }
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('wa_sid');
        res.json({ success: true, message: 'Logged out', redirect: '/login' });
    });
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
    if (!req.session.authenticated) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    const role = req.session.userRole;
    res.json({
        success: true,
        data: {
            username: req.session.username,
            role,
            loginAt:  req.session.loginAt,
            allowedSections: normalizeAllowedSections(req.session.allowedSections, role),
        },
    });
});

// ─── User Management (Center only) ───────────────────────────────────────────

function requireAdmin(req, res, next) {
    if (!req.session?.authenticated) {
        return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    const role = req.session.userRole || 'operator';
    const allowedSections = normalizeAllowedSections(req.session.allowedSections, role);
    if (!allowedSections.includes('users')) {
        return res.status(403).json({ success: false, message: 'Access denied: users section required' });
    }
    next();
}

// GET /auth/users
router.get('/users', requireAdmin, async (req, res) => {
    try {
        const users = await query(
            'SELECT id, username, role, allowed_sections, active, created_at, updated_at FROM users ORDER BY id ASC'
        );
        res.json({ success: true, data: users.map(u => ({ ...u, allowed_sections: normalizeAllowedSections(u.allowed_sections, u.role) })) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// POST /auth/users  — create user
router.post('/users', requireAdmin, async (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const { role, allowed_sections } = req.body;
    if (!username || !password || !role) {
        return res.status(400).json({ success: false, message: 'username, password, role required' });
    }
    if (!isValidUsername(username)) {
        return res.status(400).json({ success: false, message: 'Invalid username format' });
    }
    if (!isStrongEnoughPassword(password)) {
        return res.status(400).json({ success: false, message: 'Password must be 8-128 characters' });
    }
    if (!ROLES.includes(role)) {
        return res.status(400).json({ success: false, message: `role must be one of: ${ROLES.join(', ')}` });
    }
    try {
        const hashed = await bcrypt.hash(password, 10);
        const allowedSections = normalizeAllowedSections(allowed_sections, role);
        await query(
            'INSERT INTO users (username, password, role, allowed_sections) VALUES (?, ?, ?, ?)',
            [username, hashed, role, JSON.stringify(allowedSections)]
        );
        const user = await queryOne('SELECT id, username, role, allowed_sections, active, created_at FROM users WHERE username = ?', [username]);
        res.json({ success: true, data: { ...user, allowed_sections: normalizeAllowedSections(user.allowed_sections, user.role) } });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, message: 'Username already exists' });
        }
        res.status(500).json({ success: false, message: 'Failed to create user' });
    }
});

// PATCH /auth/users/:id  — update role, active, or password
router.patch('/users/:id', requireAdmin, async (req, res) => {
    const userId = parsePositiveId(req.params.id);
    if (!userId) return res.status(400).json({ success: false, message: 'Invalid user id' });
    const { username, role, active, password, allowed_sections } = req.body;
    const sets = [];
    const vals = [];
    const nextRole = role !== undefined ? role : null;

    if (username !== undefined) {
        const clean = normalizeUsername(username);
        if (!isValidUsername(clean)) {
            return res.status(400).json({ success: false, message: 'Invalid username format' });
        }
        sets.push('username = ?'); vals.push(clean);
    }

    if (role !== undefined) {
        if (!ROLES.includes(role)) {
            return res.status(400).json({ success: false, message: `role must be one of: ${ROLES.join(', ')}` });
        }
        sets.push('role = ?'); vals.push(role);
    }
    if (allowed_sections !== undefined) {
        const effectiveRole = nextRole || (await queryOne('SELECT role FROM users WHERE id = ?', [userId]))?.role || 'operator';
        const allowedSections = normalizeAllowedSections(allowed_sections, effectiveRole);
        sets.push('allowed_sections = ?'); vals.push(JSON.stringify(allowedSections));
    }
    if (active !== undefined) { sets.push('active = ?'); vals.push(active ? 1 : 0); }
    if (password) {
        if (!isStrongEnoughPassword(password)) {
            return res.status(400).json({ success: false, message: 'Password must be 8-128 characters' });
        }
        const hashed = await bcrypt.hash(password, 10);
        sets.push('password = ?'); vals.push(hashed);
    }

    if (!sets.length) return res.status(400).json({ success: false, message: 'Nothing to update' });

    try {
        vals.push(userId);
        await query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);
        const user = await queryOne('SELECT id, username, role, allowed_sections, active, updated_at FROM users WHERE id = ?', [userId]);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        const normalizedAllowedSections = normalizeAllowedSections(user.allowed_sections, user.role);

        if (String(req.session.userId || '') === String(user.id)) {
            req.session.username = user.username;
            req.session.userRole = user.role;
            req.session.allowedSections = normalizedAllowedSections;
        }

        req.session.save((saveErr) => {
            if (saveErr) {
                return res.status(500).json({ success: false, message: 'Failed to refresh session after user update' });
            }
            res.json({ success: true, data: { ...user, allowed_sections: normalizedAllowedSections } });
        });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ success: false, message: 'Username already exists' });
        }
        res.status(500).json({ success: false, message: 'Failed to update user' });
    }
});

// DELETE /auth/users/:id
router.delete('/users/:id', requireAdmin, async (req, res) => {
    const userId = parsePositiveId(req.params.id);
    if (!userId) return res.status(400).json({ success: false, message: 'Invalid user id' });
    try {
        const result = await query('DELETE FROM users WHERE id = ?', [userId]);
        if (!result.affectedRows) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, message: 'User deleted' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete user' });
    }
});

module.exports = router;
