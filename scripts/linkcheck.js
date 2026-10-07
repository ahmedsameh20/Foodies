// Crawls a running server and reports internal links/assets that do not resolve.
// Usage: node scripts/linkcheck.js http://localhost:3000
const fs = require('node:fs');
const path = require('node:path');

const base = process.argv[2] || 'http://localhost:3000';
const root = path.resolve(__dirname, '..');
// Assets referenced by the ORIGINAL static pages that were never present in the project; nothing to restore.
const KNOWN_MISSING = new Set(['/legacy/Images/Dishes/chilli-prawns.jpg']);
const seen = new Map();
const broken = [];

const find = (src) => [...src.matchAll(/(?:href|src)=["']([^"'#][^"']*)["']/g)].map((m) => m[1]);

async function check(url, from) {
  if (seen.has(url)) return seen.get(url);
  const res = await fetch(url, { redirect: 'follow' });
  seen.set(url, res.status);
  if (res.status >= 400 && !KNOWN_MISSING.has(new URL(url).pathname)) broken.push(`${res.status} ${url}  (from ${from})`);
  return res.status;
}

function internal(link, pageUrl) {
  if (/^(https?:)?\/\//.test(link) || /^(mailto|tel|javascript|data):/.test(link) || link.includes('${')) return null;
  const u = new URL(link, pageUrl);
  if (u.pathname.startsWith('/api/')) return null; // authenticated endpoints are covered by the API tests
  return u.origin === new URL(base).origin ? u.href.split('#')[0] : null;
}

async function crawl(files, urlOf) {
  for (const f of files) {
    const pageUrl = urlOf(f);
    const src = fs.readFileSync(f, 'utf8');
    for (const l of find(src)) {
      const target = internal(l, pageUrl);
      if (target) await check(target, path.relative(root, f));
    }
  }
}

(async () => {
  const pub = path.join(root, 'public');
  const html = fs.readdirSync(pub).filter((f) => f.endsWith('.html')).map((f) => path.join(pub, f));
  const js = fs.readdirSync(path.join(pub, 'js')).map((f) => path.join(pub, 'js', f));
  await crawl(html, (f) => `${base}/${path.basename(f)}`);
  await crawl(js, () => `${base}/`); // links rendered by JS use absolute paths
  const legacyDir = path.join(root, 'legacy');
  const legacy = fs.readdirSync(legacyDir).filter((f) => f.endsWith('.html')).map((f) => path.join(legacyDir, f));
  await crawl(legacy, (f) => `${base}/legacy/${path.basename(f)}`);
  console.log(`checked ${seen.size} unique internal URLs`);
  if (broken.length) {
    console.log(`${broken.length} broken:`);
    for (const b of broken) console.log(`  ${b}`);
    process.exit(1);
  }
  console.log('no broken internal links');
})();
