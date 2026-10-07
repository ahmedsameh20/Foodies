// Dependency-free static check: every JS file must parse, and no server file may use
// string-concatenated SQL with request data. Run with `npm run check`.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dirs = ['server', 'public/js', 'tests', 'scripts'];
let failures = 0;
function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}
for (const dir of dirs) {
  for (const f of walk(path.join(root, dir))) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      failures++;
      console.error(`SYNTAX ERROR ${path.relative(root, f)}\n${e.stderr}`);
    }
  }
}
// Cheap guard against SQL built from template literals containing request data in route files.
for (const f of walk(path.join(root, 'server/routes'))) {
  const src = fs.readFileSync(f, 'utf8');
  const bad = src.match(/\.(prepare|exec)\(\s*`[^`]*\$\{\s*req\./g);
  if (bad) { failures++; console.error(`Possible SQL interpolation of req.* in ${path.relative(root, f)}`); }
}
if (failures) { console.error(`${failures} problem(s) found`); process.exit(1); }
console.log('check: all files parse; no request data interpolated into SQL');
