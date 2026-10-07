// Opening hours: {"mon":[{"open":"09:00","close":"22:00"}], ...}. A missing/empty object means "always open".
const { bad } = require('../utils');

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseHours(input) {
  if (input === null || input === undefined || input === '') return null;
  const obj = typeof input === 'string' ? safeJson(input) : input;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw bad('openingHours: must be an object keyed by weekday', { field: 'openingHours' });
  const out = {};
  for (const [day, ranges] of Object.entries(obj)) {
    if (!DAYS.includes(day)) throw bad(`openingHours: unknown day "${day}"`, { field: 'openingHours' });
    if (!Array.isArray(ranges) || ranges.length > 4) throw bad(`openingHours.${day}: expected up to 4 ranges`, { field: 'openingHours' });
    out[day] = ranges.map((r) => {
      if (!r || !HHMM.test(r.open) || !HHMM.test(r.close) || r.open === r.close) {
        throw bad(`openingHours.${day}: use HH:MM times with different open/close`, { field: 'openingHours' });
      }
      return { open: r.open, close: r.close };
    });
  }
  return Object.keys(out).length ? out : null;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Local weekday + minutes-since-midnight in the restaurant's timezone.
function localParts(now, timezone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { day: p.weekday.slice(0, 3).toLowerCase(), minutes: Number(p.hour) * 60 + Number(p.minute) };
}

const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

function isOpenNow(hoursJson, timezone, now = new Date()) {
  const hours = typeof hoursJson === 'string' ? safeJson(hoursJson) : hoursJson;
  if (!hours || !Object.keys(hours).length) return true;
  const { day, minutes } = localParts(now, timezone || 'UTC');
  const prevDay = DAYS[(DAYS.indexOf(day) + 6) % 7];
  const inRange = (r, today) => {
    const o = toMin(r.open); const c = toMin(r.close);
    if (o < c) return today && minutes >= o && minutes < c;
    // overnight range (e.g. 18:00-02:00): evening part belongs to today, after-midnight part to the previous day
    return today ? minutes >= o : minutes < c;
  };
  return (hours[day] || []).some((r) => inRange(r, true)) || (hours[prevDay] || []).some((r) => toMin(r.open) > toMin(r.close) && inRange(r, false));
}

module.exports = { parseHours, validTimezone, isOpenNow, DAYS };
