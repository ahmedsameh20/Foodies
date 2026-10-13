// Owner image uploads: content check, storage under uploads/<restaurantId>/ and clean-up of files nothing refers to any more.
// A stored image is only ever addressed as /uploads/<restaurantId>/<random>.<ext>; a restaurant can only point at (or delete) its own files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { HttpError } = require('../utils');

const MAX_BYTES = 2 * 1024 * 1024;
const MAGIC = [
  { ext: 'png', test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
];

// Trust the file's contents, not the declared type. Returns the extension or throws 415.
function detectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new HttpError(415, 'unsupported_media', 'Upload a PNG, JPEG or WebP image (max 2 MB)');
  const kind = MAGIC.find((m) => m.test(buf));
  if (!kind) throw new HttpError(415, 'unsupported_media', 'File is not a valid PNG, JPEG or WebP image');
  return kind.ext;
}

function saveImage(restaurantId, buf) {
  const ext = detectImage(buf);
  const dir = path.join(config.uploadDir, String(restaurantId));
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return `/uploads/${restaurantId}/${name}`;
}

const ownFile = (restaurantId, url) => {
  const m = new RegExp(`^/uploads/${Number(restaurantId)}/([a-f0-9]{24}\\.(?:png|jpg|webp))$`).exec(String(url || ''));
  return m ? path.join(config.uploadDir, String(restaurantId), m[1]) : null;
};

// Deletes the file behind `url` when it is one of THIS restaurant's uploads and no logo, cover, dish, extra or category still uses it.
function removeIfOrphan(db, restaurantId, url) {
  const file = ownFile(restaurantId, url);
  if (!file) return false;
  const used = db.prepare(
    `SELECT 1 FROM categories WHERE restaurant_id = ? AND image_url = ?
     UNION ALL SELECT 1 FROM products WHERE restaurant_id = ? AND image_url = ?
     UNION ALL SELECT 1 FROM restaurant_extras WHERE restaurant_id = ? AND image_url = ?
     UNION ALL SELECT 1 FROM restaurants WHERE id = ? AND (logo_url = ? OR cover_url = ?)`).get(restaurantId, url, restaurantId, url, restaurantId, url, restaurantId, url, url);
  if (used) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

module.exports = { MAX_BYTES, detectImage, saveImage, removeIfOrphan, ownFile };
