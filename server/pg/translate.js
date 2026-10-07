// SQLite-flavoured SQL -> PostgreSQL. The application's queries are written once, in portable SQL plus a handful of SQLite
// idioms; this module rewrites exactly those idioms. It is deliberately small and conservative: string literals are never
// touched, and anything it does not know is passed through unchanged (PostgreSQL then reports a precise error).
//
//   ?                                    ->  $1, $2 ...
//   strftime('%Y-%m-%dT%H:%M:%fZ','now') ->  iso_now()                       (defined in migrations/postgres/001_schema.sql)
//   INSERT OR IGNORE INTO t ...          ->  INSERT INTO t ... ON CONFLICT DO NOTHING
//   LIKE                                 ->  ILIKE                           (SQLite LIKE is case-insensitive for ASCII)
//   $n IS [NOT] NULL                     ->  $n::text IS [NOT] NULL          (PostgreSQL cannot infer an untyped parameter there)
//   INSERT INTO t ... (t has an id)      ->  ... RETURNING id                (feeds lastInsertRowid)
const ISO_NOW = /strftime\(\s*'%Y-%m-%dT%H:%M:%fZ'\s*,\s*'now'\s*\)/gi;

// Apply fn to the parts of the statement that are not inside '...' literals.
function mapCode(sql, fn) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const q = sql.indexOf("'", i);
    if (q === -1) { out += fn(sql.slice(i)); break; }
    out += fn(sql.slice(i, q));
    let j = q + 1;
    while (j < sql.length) {
      if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
      else if (sql[j] === "'") { j += 1; break; } else j += 1;
    }
    out += sql.slice(q, j);
    i = j;
  }
  return out;
}

function translate(sqlIn, hasId) {
  let sql = sqlIn.replace(ISO_NOW, 'iso_now()');
  let ignore = false;
  let n = 0;
  sql = mapCode(sql, (code) => code
    .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, () => { ignore = true; return 'INSERT INTO'; })
    .replace(/\bLIKE\b/g, 'ILIKE')
    .replace(/\?/g, () => `$${++n}`)
    .replace(/(\$\d+)(\s+IS\s+(?:NOT\s+)?NULL\b)/gi, '$1::text$2'));
  const m = /^\s*INSERT\s+INTO\s+"?(\w+)"?/i.exec(sql);
  let table = null;
  if (m) {
    table = m[1];
    const body = sql.replace(/;\s*$/, '');
    let text = body;
    if (ignore && !/\bON\s+CONFLICT\b/i.test(text)) text += ' ON CONFLICT DO NOTHING';
    if (!/\bRETURNING\b/i.test(text) && hasId(table)) text += ' RETURNING id';
    sql = text;
  }
  return { text: sql, nparams: n, table };
}

module.exports = { translate, mapCode };
