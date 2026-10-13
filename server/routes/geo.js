// Address search for the map pickers (registration and branch management). Signed-in users only; see services/geocode.js.
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');
const geocode = require('../services/geocode');
const { HttpError, ok } = require('../utils');

const router = express.Router();
router.use(requireAuth);
if (config.rateLimitEnabled) {
  router.use(rateLimit({
    windowMs: 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'rate_limited', 'Too many address searches. Please wait a moment.')),
  }));
}
const language = (req) => (req.query.lang === 'ar' ? 'ar' : 'en');

router.get('/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 3 || q.length > 200) throw new HttpError(400, 'validation_error', 'q: type at least 3 characters', { field: 'q', reason: 'too_short', min: 3 });
  ok(res, { results: await geocode.search(q, language(req)) });
});

router.get('/reverse', async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new HttpError(400, 'validation_error', 'lat/lon: invalid coordinate', { field: 'lat', reason: 'invalid_coordinate' });
  ok(res, { results: await geocode.reverse(lat, lon, language(req)) });
});

module.exports = router;
