import fs from 'node:fs';
import { audit, db } from '../src/database.mjs';
import { encryptSecret } from '../src/security.mjs';

const passwordPath = process.env.GO2RTC_API_PASSWORD_FILE;
if (!passwordPath) throw new Error('GO2RTC_API_PASSWORD_FILE is required');

const gatewayPassword = fs.readFileSync(passwordPath, 'utf8').trim();
if (gatewayPassword.length < 32) throw new Error('go2rtc password is unexpectedly short');

const printer = db.prepare("SELECT * FROM devices WHERE slug = 'k1se-01' COLLATE NOCASE").get();
if (!printer || printer.kind !== 'printer') throw new Error('Creality K1 SE device is missing');

const encrypted = encryptSecret(JSON.stringify({ username: 'laba-vps', password: gatewayPassword }));

const cameraId = db.transaction(() => {
  const existing = db.prepare("SELECT * FROM devices WHERE slug = 'labacam' COLLATE NOCASE").get();
  if (existing) {
    db.prepare(`
      UPDATE devices SET
        name = 'Камера Creality K1 SE', kind = 'camera', driver = 'http',
        host = '100.69.168.10', protocol = 'http', ui_port = 1984, api_port = NULL,
        stream_name = 'printer-usb-camera', stream_mode = 'mjpeg', parent_device_id = ?,
        secret_enc = ?, notes = 'Logitech C270 · USB · 1280×720 · 30 FPS',
        enabled = 1, sort_order = 11, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(printer.id, encrypted, existing.id);
    return existing.id;
  }

  return Number(db.prepare(`
    INSERT INTO devices
      (slug, name, kind, driver, host, protocol, ui_port, api_port, stream_name,
       stream_mode, parent_device_id, secret_enc, notes, enabled, sort_order)
    VALUES
      ('labacam', 'Камера Creality K1 SE', 'camera', 'http', '100.69.168.10',
       'http', 1984, NULL, 'printer-usb-camera', 'mjpeg', ?, ?,
       'Logitech C270 · USB · 1280×720 · 30 FPS', 1, 11)
  `).run(printer.id, encrypted).lastInsertRowid);
})();

audit('system:usb-camera-deployment', 'device.configure', 'device', cameraId, {
  slug: 'labacam',
  parentSlug: 'k1se-01',
  streamName: 'printer-usb-camera'
});

console.log(`Configured camera device ${cameraId} for printer ${printer.id}`);
db.close();
