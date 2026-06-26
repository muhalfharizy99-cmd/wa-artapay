require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'wa_gateway'
    });

    console.log('\n=== Current Devices ===');
    const [devices] = await conn.query('SELECT id, device_id, type, name FROM devices');
    console.log(JSON.stringify(devices, null, 2));

    if (devices.length === 0) {
      console.log('No devices found. Please create devices first.');
      await conn.end();
      return;
    }

    // Update device types based on device_id
    for (const device of devices) {
      const deviceId = device.device_id;
      const deviceName = device.name || '';
      let newType = 'none';

      // Set type based on device name (WA CENTER = center, WA SENDER = sender)
      if (deviceName.toLowerCase().includes('center')) {
        newType = 'center';
      } else if (deviceName.toLowerCase().includes('sender')) {
        newType = 'sender';
      }

      if (newType !== 'none' && device.type !== newType) {
        console.log(`\nUpdating device ${deviceId} (${deviceName}) from ${device.type} to ${newType}`);
        await conn.query('UPDATE devices SET type = ? WHERE device_id = ?', [newType, deviceId]);
        console.log(`✅ Device ${deviceId} updated to ${newType}`);
      } else {
        console.log(`\nDevice ${deviceId} (${deviceName}) already has type ${device.type}`);
      }
    }

    console.log('\n=== Updated Devices ===');
    const [updatedDevices] = await conn.query('SELECT id, device_id, type, name FROM devices');
    console.log(JSON.stringify(updatedDevices, null, 2));

    await conn.end();
    console.log('\n✅ Device type update completed!');
    console.log('⚠️ Please restart the WA Gateway service for changes to take effect.');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
})();
