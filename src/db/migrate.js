const mysql  = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const config = require('../config/config');

async function migrate() {
    // Connect without selecting database first to ensure it exists
    const conn = await mysql.createConnection({
        host:     config.db.host,
        port:     config.db.port,
        user:     config.db.user,
        password: config.db.password,
    });

    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(`USE \`${config.db.database}\``);

    // Users table
    await conn.query(`
        CREATE TABLE IF NOT EXISTS users (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            username   VARCHAR(50)  NOT NULL UNIQUE,
            password   VARCHAR(255) NOT NULL,
            role       ENUM('admin','cs','operator') NOT NULL DEFAULT 'operator',
            allowed_sections TEXT NULL,
            active     TINYINT(1)   NOT NULL DEFAULT 1,
            created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // App settings table
    await conn.query(`
        CREATE TABLE IF NOT EXISTS app_settings (
            setting_key   VARCHAR(100) PRIMARY KEY,
            setting_value TEXT         DEFAULT NULL,
            updated_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Migrate: rename type → role for existing databases
    {
        const [typeCol] = await conn.query(`SHOW COLUMNS FROM users LIKE 'type'`);
        const [roleCol] = await conn.query(`SHOW COLUMNS FROM users LIKE 'role'`);
        const [allowedSectionsCol] = await conn.query(`SHOW COLUMNS FROM users LIKE 'allowed_sections'`);

        if (typeCol.length > 0 && roleCol.length === 0) {
            // Step 1: relax to VARCHAR so old ENUM values don't block updates
            await conn.query(`ALTER TABLE users MODIFY COLUMN type VARCHAR(20) NOT NULL DEFAULT 'operator'`);
            // Step 2: remap old values
            await conn.query(`UPDATE users SET type = 'admin'    WHERE type = 'center'`);
            await conn.query(`UPDATE users SET type = 'cs'       WHERE type = 'sender'`);
            await conn.query(`UPDATE users SET type = 'operator' WHERE type NOT IN ('admin','cs','operator')`);
            // Step 3: rename + enforce ENUM
            await conn.query(`ALTER TABLE users CHANGE COLUMN type role ENUM('admin','cs','operator') NOT NULL DEFAULT 'operator'`);
            console.log('[DB] Migrated users.type → users.role successfully');
        } else if (typeCol.length === 0 && roleCol.length === 0) {
            // Fresh table — already created with role column above, nothing to do
        }

        if (allowedSectionsCol.length === 0) {
            await conn.query(`ALTER TABLE users ADD COLUMN allowed_sections TEXT NULL AFTER role`);
        }

        await conn.query(`
            UPDATE users
            SET allowed_sections = CASE role
                WHEN 'admin' THEN JSON_ARRAY('dashboard','device','messages','testing','blast','history','logs','docs','users','settings')
                WHEN 'cs' THEN JSON_ARRAY('messages','testing','blast','history','logs','docs','settings')
                ELSE JSON_ARRAY('messages','testing','blast','docs','settings')
            END
            WHERE allowed_sections IS NULL OR allowed_sections = ''
        `);
    }

    // Webhooks table (per device_id)
    await conn.query(`
        CREATE TABLE IF NOT EXISTS webhooks (
            id          VARCHAR(36)  NOT NULL PRIMARY KEY,
            device_id   VARCHAR(50)  NOT NULL DEFAULT '*',
            url         VARCHAR(500) NOT NULL,
            events      JSON         NOT NULL,
            description VARCHAR(255) DEFAULT NULL,
            secret      VARCHAR(100) DEFAULT NULL,
            active      TINYINT(1)   NOT NULL DEFAULT 1,
            stat_sent   BIGINT       NOT NULL DEFAULT 0,
            stat_failed BIGINT       NOT NULL DEFAULT 0,
            last_sent   TIMESTAMP    DEFAULT NULL,
            created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
            updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_device_id (device_id),
            INDEX idx_active    (active)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Message logs table
    await conn.query(`
        CREATE TABLE IF NOT EXISTS message_logs (
            id         BIGINT AUTO_INCREMENT PRIMARY KEY,
            device_id  VARCHAR(50)      NOT NULL DEFAULT '*',
            direction  ENUM('in','out') NOT NULL,
            from_num   VARCHAR(50)      DEFAULT NULL,
            to_num     VARCHAR(50)      DEFAULT NULL,
            body       TEXT             DEFAULT NULL,
            type       VARCHAR(30)      NOT NULL DEFAULT 'chat',
            is_group   TINYINT(1)       NOT NULL DEFAULT 0,
            msg_id     VARCHAR(100)     DEFAULT NULL,
            mime_type  VARCHAR(150)     DEFAULT NULL,
            file_name  VARCHAR(255)     DEFAULT NULL,
            media_data LONGTEXT         DEFAULT NULL,
            is_read    TINYINT(1)       NOT NULL DEFAULT 0,
            created_at TIMESTAMP        DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_device    (device_id),
            INDEX idx_direction (direction),
            INDEX idx_created   (created_at),
            INDEX idx_from      (from_num),
            INDEX idx_to        (to_num),
            INDEX idx_is_read   (is_read)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Add is_read column to existing message_logs
    try {
        await conn.query(`ALTER TABLE message_logs ADD COLUMN is_read TINYINT(1) NOT NULL DEFAULT 0`);
        await conn.query(`UPDATE message_logs SET is_read = 1 WHERE direction = 'out'`);
    } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    try {
        await conn.query(`ALTER TABLE message_logs ADD COLUMN mime_type VARCHAR(150) DEFAULT NULL`);
    } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    try {
        await conn.query(`ALTER TABLE message_logs ADD COLUMN file_name VARCHAR(255) DEFAULT NULL`);
    } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    try {
        await conn.query(`ALTER TABLE message_logs ADD COLUMN media_data LONGTEXT DEFAULT NULL`);
    } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    // Devices table
    await conn.query(`
        CREATE TABLE IF NOT EXISTS devices (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            device_id  VARCHAR(50)  NOT NULL UNIQUE,
            name       VARCHAR(100) DEFAULT NULL,
            phone      VARCHAR(20)  DEFAULT NULL,
            pushname   VARCHAR(100) DEFAULT NULL,
            platform   VARCHAR(50)  DEFAULT NULL,
            api_key    VARCHAR(64)  DEFAULT NULL UNIQUE,
            status     ENUM('disconnected','connecting','qr','ready') NOT NULL DEFAULT 'disconnected',
            active     TINYINT(1)   NOT NULL DEFAULT 1,
            last_seen  TIMESTAMP    DEFAULT NULL,
            created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_device_id (device_id),
            INDEX idx_status    (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Add api_key column to existing databases (safe for re-runs on any MySQL version)
    try {
        await conn.query(`ALTER TABLE devices ADD COLUMN api_key VARCHAR(64) DEFAULT NULL UNIQUE`);
    } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    // Add type column to existing databases
    try {
        await conn.query(`ALTER TABLE devices ADD COLUMN type ENUM('sender','center','none') NOT NULL DEFAULT 'none' AFTER name`);
    } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    // Add incoming ack reply toggle column to existing databases
    try {
        await conn.query(`ALTER TABLE devices ADD COLUMN incoming_ack_reply_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER active`);
    } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    // Add webhook reply delay (seconds) per device
    try {
        await conn.query(`ALTER TABLE devices ADD COLUMN webhook_reply_delay INT NOT NULL DEFAULT 0 AFTER incoming_ack_reply_enabled`);
    } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }

    // Remove legacy global webhooks now that only per-device webhooks are supported
    await conn.query(`DELETE FROM webhooks WHERE device_id = '*'`).catch(() => {});

    // Webhook delivery logs table
    await conn.query(`
        CREATE TABLE IF NOT EXISTS webhook_logs (
            id          BIGINT AUTO_INCREMENT PRIMARY KEY,
            webhook_id  VARCHAR(36)   DEFAULT NULL,
            device_id   VARCHAR(50)   DEFAULT NULL,
            event       VARCHAR(50)   DEFAULT NULL,
            payload     JSON          DEFAULT NULL,
            success     TINYINT(1)    NOT NULL DEFAULT 0,
            status_code SMALLINT      DEFAULT NULL,
            error       TEXT          DEFAULT NULL,
            duration_ms INT           DEFAULT NULL,
            created_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_webhook  (webhook_id),
            INDEX idx_device   (device_id),
            INDEX idx_event    (event),
            INDEX idx_created  (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Composite indexes for sorted queries (avoids filesort + sort memory errors)
    try {
        await conn.query(`ALTER TABLE webhook_logs ADD INDEX idx_device_created (device_id, created_at)`);
    } catch (e) {
        if (e.code !== 'ER_DUP_KEYNAME') throw e;
    }
    try {
        await conn.query(`ALTER TABLE message_logs ADD INDEX idx_device_created (device_id, created_at)`);
    } catch (e) {
        if (e.code !== 'ER_DUP_KEYNAME') throw e;
    }
    // Index for ORDER BY id DESC (used by /message-logs listing)
    try {
        await conn.query(`ALTER TABLE webhook_logs ADD INDEX idx_id_desc (id DESC)`);
    } catch (e) {
        if (e.code !== 'ER_DUP_KEYNAME') throw e;
    }
    // Index for message_logs conversations subquery GROUP BY + ORDER
    try {
        await conn.query(`ALTER TABLE message_logs ADD INDEX idx_type_created (type, created_at)`);
    } catch (e) {
        if (e.code !== 'ER_DUP_KEYNAME') throw e;
    }
    // Composite index for conversations GROUP BY (device_id, direction, from_num, to_num)
    try {
        await conn.query(`ALTER TABLE message_logs ADD INDEX idx_conv (device_id, direction, from_num, to_num, id)`);
    } catch (e) {
        if (e.code !== 'ER_DUP_KEYNAME') throw e;
    }
    // Composite index for msg_id dedup lookups
    try {
        await conn.query(`ALTER TABLE message_logs ADD INDEX idx_device_msgid (device_id, msg_id)`);
    } catch (e) {
        if (e.code !== 'ER_DUP_KEYNAME') throw e;
    }

    // Seed default users (hashed passwords)
    const [[{ cnt }]] = await conn.query('SELECT COUNT(*) as cnt FROM users');
    if (cnt === 0) {
        const [h1, h2, h3] = await Promise.all([
            bcrypt.hash('admin123',    10),
            bcrypt.hash('cs123',       10),
            bcrypt.hash('operator123', 10),
        ]);
        await conn.query(
            'INSERT INTO users (username, password, role, active) VALUES (?,?,?,1),(?,?,?,1),(?,?,?,1)',
            ['admin', h1, 'admin', 'cs', h2, 'cs', 'operator', h3, 'operator']
        );
        console.log('[DB] Default users seeded: admin (admin), cs (cs), operator (operator)');
    }
    // Rehash any plaintext passwords (upgrade from old installs)
    const [users] = await conn.query('SELECT id, password FROM users');
    for (const u of users) {
        if (!u.password.startsWith('$2')) {
            const hashed = await bcrypt.hash(u.password, 10);
            await conn.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, u.id]);
        }
    }

    // Backfill api_key for any device that has none
    const crypto = require('crypto');
    const [noKey] = await conn.query('SELECT id FROM devices WHERE api_key IS NULL');
    for (const d of noKey) {
        await conn.execute('UPDATE devices SET api_key = ? WHERE id = ?', [crypto.randomBytes(32).toString('hex'), d.id]);
    }

    // Blast contacts table
    await conn.query(`
        CREATE TABLE IF NOT EXISTS blast_contacts (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            name       VARCHAR(100)     DEFAULT NULL,
            phone      VARCHAR(20)      NOT NULL,
            device_id  VARCHAR(50)      NOT NULL DEFAULT '*',
            group_id   INT              DEFAULT NULL,
            active     TINYINT(1)       NOT NULL DEFAULT 1,
            created_at TIMESTAMP        DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP        DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY idx_phone_device (phone, device_id),
            INDEX idx_device (device_id),
            INDEX idx_group (group_id),
            INDEX idx_active (active)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
        await conn.query(`ALTER TABLE blast_contacts ADD COLUMN group_id INT DEFAULT NULL AFTER device_id`);
    } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    try {
        await conn.query(`ALTER TABLE blast_contacts ADD INDEX idx_group (group_id)`);
    } catch (e) {
        if (e.code !== 'ER_DUP_KEYNAME') throw e;
    }

    // Blast contact groups table
    await conn.query(`
        CREATE TABLE IF NOT EXISTS blast_contact_groups (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            name        VARCHAR(100)     NOT NULL,
            device_id   VARCHAR(50)      NOT NULL DEFAULT '*',
            created_at  TIMESTAMP        DEFAULT CURRENT_TIMESTAMP,
            updated_at  TIMESTAMP        DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY idx_group_name_device (name, device_id),
            INDEX idx_group_device (device_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Blast campaigns table
    await conn.query(`
        CREATE TABLE IF NOT EXISTS blast_campaigns (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            name        VARCHAR(100)     NOT NULL,
            message     TEXT             DEFAULT NULL,
            media_url   VARCHAR(500)     DEFAULT NULL,
            caption     VARCHAR(500)     DEFAULT NULL,
            device_id   VARCHAR(50)      NOT NULL DEFAULT '*',
            delay_ms    INT              NOT NULL DEFAULT 2000,
            schedule_at TIMESTAMP        DEFAULT NULL,
            target_type VARCHAR(20)      NOT NULL DEFAULT 'all',
            target_group_id INT          DEFAULT NULL,
            target_contact_ids JSON      DEFAULT NULL,
            status      ENUM('draft','running','paused','completed','failed') NOT NULL DEFAULT 'draft',
            total_contacts INT           NOT NULL DEFAULT 0,
            sent_count  INT              NOT NULL DEFAULT 0,
            failed_count INT            NOT NULL DEFAULT 0,
            last_run_at TIMESTAMP        DEFAULT NULL,
            created_at  TIMESTAMP        DEFAULT CURRENT_TIMESTAMP,
            updated_at  TIMESTAMP        DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_device (device_id),
            INDEX idx_status (status),
            INDEX idx_target_group (target_group_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
        await conn.query(`ALTER TABLE blast_campaigns ADD COLUMN schedule_at TIMESTAMP NULL DEFAULT NULL AFTER delay_ms`);
    } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    try {
        await conn.query(`ALTER TABLE blast_campaigns ADD COLUMN target_type VARCHAR(20) NOT NULL DEFAULT 'all' AFTER schedule_at`);
    } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    try {
        await conn.query(`ALTER TABLE blast_campaigns ADD COLUMN target_group_id INT DEFAULT NULL AFTER target_type`);
    } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    try {
        await conn.query(`ALTER TABLE blast_campaigns ADD COLUMN target_contact_ids JSON DEFAULT NULL AFTER target_group_id`);
    } catch (e) {
        if (e.code !== 'ER_DUP_FIELDNAME') throw e;
    }
    try {
        await conn.query(`ALTER TABLE blast_campaigns ADD INDEX idx_target_group (target_group_id)`);
    } catch (e) {
        if (e.code !== 'ER_DUP_KEYNAME') throw e;
    }

    // Blast logs table (individual send results)
    await conn.query(`
        CREATE TABLE IF NOT EXISTS blast_logs (
            id          BIGINT AUTO_INCREMENT PRIMARY KEY,
            campaign_id INT              NOT NULL,
            contact_id  INT              NOT NULL,
            phone       VARCHAR(20)      NOT NULL,
            status      ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
            error_msg   TEXT             DEFAULT NULL,
            sent_at     TIMESTAMP        DEFAULT NULL,
            created_at  TIMESTAMP        DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_campaign (campaign_id),
            INDEX idx_contact (contact_id),
            INDEX idx_status (status),
            INDEX idx_phone (phone)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Sessions table for persistent login (survives restarts)
    await conn.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            session_id VARCHAR(128) NOT NULL PRIMARY KEY,
            expires    BIGINT UNSIGNED NOT NULL,
            data       MEDIUMTEXT,
            INDEX idx_expires (expires)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.end();
    console.log('[DB] Migration completed successfully');
}

module.exports = { migrate };
