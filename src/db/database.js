const mysql = require('mysql2/promise');
const config = require('../config/config');

let pool = null;

async function getPool() {
    if (pool) return pool;
    pool = mysql.createPool({
        host:               config.db.host,
        port:               config.db.port,
        user:               config.db.user,
        password:           config.db.password,
        database:           config.db.database,
        waitForConnections: config.db.waitForConnections,
        connectionLimit:    config.db.connectionLimit,
        queueLimit:         config.db.queueLimit,
    });
    return pool;
}

async function query(sql, params = []) {
    const p = await getPool();
    const [rows] = await p.execute(sql, params);
    return rows;
}

async function queryOne(sql, params = []) {
    const rows = await query(sql, params);
    return rows[0] || null;
}

module.exports = { getPool, query, queryOne };
