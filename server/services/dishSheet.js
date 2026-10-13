// Excel (.xlsx) import / export of dishes. Used by routes/manageMenu.js; everything is scoped to the authenticated owner's restaurant.
//
// Security model:
//   * the restaurant id NEVER comes from the file - there is no such column and nothing in the sheet can select a restaurant;
//   * ids in the sheet (dish ID, branch ids in column headers) are only honoured when they belong to THIS restaurant;
//   * the upload is size-limited by the route, must be a ZIP container, and its declared uncompressed size is checked before parsing;
//   * every value is validated here on the server (the browser preview is only a convenience), invalid rows are reported with the
//     spreadsheet row number and the column, and nothing is written unless the whole import is acceptable (or the owner explicitly
//     chose to skip the invalid rows);
//   * all writes happen in ONE transaction: a failure leaves the menu exactly as it was;
//   * cells that would be interpreted as formulas by a spreadsheet application are neutralised on export (and the guard is removed again on import);
//   * images are never read from local paths: an image column must be an https URL or an already uploaded /uploads or /Images path.
const ExcelJS = require('exceljs');
const { tx } = require('../db');
const { HttpError, imageUrl } = require('../utils');
const { enforceLimit } = require('./plans');
const inventory = require('./inventory');
const { MAX_PRICE_CENTS } = require('./catalog');

const SHEET = 'Dishes';
const MAX_ROWS = 1000;
const MAX_COLS = 150;
const MAX_STOCK = 1e6;
const MAX_UNZIPPED = 25 * 1024 * 1024;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// key -> English header (what the owner sees) + normalised aliases accepted on import
const COLS = [
  { key: 'id', header: 'ID', aliases: ['id', 'dishid'], note: 'Leave empty to create a new dish. Needed (and must belong to your restaurant) when updating existing dishes.' },
  { key: 'nameAr', header: 'Name (Arabic)', aliases: ['namearabic', 'namear', 'arabicname'], required: true },
  { key: 'nameEn', header: 'Name (English)', aliases: ['nameenglish', 'nameen', 'englishname'], required: true },
  { key: 'descriptionAr', header: 'Description (Arabic)', aliases: ['descriptionarabic', 'descriptionar', 'arabicdescription'], required: true },
  { key: 'descriptionEn', header: 'Description (English)', aliases: ['descriptionenglish', 'descriptionen', 'englishdescription'], required: true },
  { key: 'category', header: 'Category', aliases: ['category', 'categoryname'], note: 'The name (Arabic or English) of one of your existing categories. Empty = no category.' },
  { key: 'original', header: 'Original Price', aliases: ['originalprice', 'price'], required: true, note: 'Plain number, at most 2 decimals, e.g. 12.50' },
  { key: 'discounted', header: 'Discounted Price', aliases: ['discountedprice', 'saleprice'], note: 'Optional. Must be lower than the original price. Empty = no discount.' },
  { key: 'available', header: 'Available', aliases: ['available', 'isavailable', 'availability'], note: 'yes / no. Empty means NO: nothing is published unless you say so.' },
  { key: 'track', header: 'Track Stock', aliases: ['trackstock', 'tracked'], note: 'yes = limited quantity, no = unlimited.' },
  { key: 'stock', header: 'Stock Quantity', aliases: ['stockquantity', 'quantity', 'stock'], note: 'Only for restaurants without branches. With branches use the "Stock - <branch>" columns.' },
  { key: 'image', header: 'Image URL', aliases: ['imageurl', 'image'], note: 'Optional https:// address, or an image you already uploaded to the dashboard.' },
];
const BRANCH_HEADER = /^stock\b.*\(#(\d+)\)\s*$/i;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, '');
const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '٫': '.' };

const bad = (code, message, extra) => new HttpError(400, 'validation_error', `file: ${message}`, { field: 'file', reason: code, ...(extra || {}) });

// ---------------------------------------------------------------- export / template
const guard = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const unguard = (v) => (typeof v === 'string' && /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);
const money = (cents) => Math.round(cents) / 100;
const branchHeader = (b) => `Stock - ${b.name} (#${b.id})`;

function addReferenceSheets(wb, categories, branches) {
  const ref = wb.addWorksheet('Reference');
  ref.addRow(['Categories (use these names in the Category column)']).font = { bold: true };
  ref.addRow(['Name (English)', 'Name (Arabic)']).font = { bold: true };
  for (const c of categories) ref.addRow([guard(c.name_en || c.name), guard(c.name_ar || '')]);
  ref.addRow([]);
  ref.addRow(['Branches (stock columns in the Dishes sheet)']).font = { bold: true };
  ref.addRow(['ID', 'Name']).font = { bold: true };
  for (const b of branches) ref.addRow([b.id, guard(b.name)]);
  ref.getColumn(1).width = 44; ref.getColumn(2).width = 36;
}

function addInstructions(wb, branches) {
  const ws = wb.addWorksheet('Instructions', { views: [{ showGridLines: false }] });
  const lines = [
    ['How to use this file'],
    ['1. Fill the "Dishes" sheet: one dish per row, keep the header row exactly as it is.'],
    ['2. Create mode (default): leave the ID column empty. Existing dishes are never overwritten; a dish whose English name already exists is skipped.'],
    ['3. Update mode: the ID column must contain the ID of an existing dish of your restaurant (use "Export to Excel" to get them). Matching by name is never used.'],
    ['4. Text columns (names and descriptions in Arabic and English) are all required. Prices are plain numbers with at most 2 decimals.'],
    ['5. Available: yes / no (an empty cell means no - the dish is imported hidden). Track Stock: yes / no.'],
    ['6. Stock: restaurants with branches have one "Stock - <branch> (#id)" column per branch; do not rename them. An empty stock cell leaves that branch untouched.'],
    ['7. Category: the name of an existing category (see the Reference sheet). Unknown categories are reported as errors; none are created.'],
    ['8. Image URL: an https:// link only. Files on your computer cannot be imported.'],
    ['9. You will see a preview with every problem (sheet row and column) before anything is saved.'],
    ['Limits: at most 1000 dishes and 2 MB per file.'],
  ];
  lines.forEach((l, i) => { const r = ws.addRow(l); if (i === 0) r.font = { bold: true, size: 14 }; });
  ws.getColumn(1).width = 140;
  void branches;
}

function dishesSheet(wb, branches) {
  const ws = wb.addWorksheet(SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  const headers = [];
  for (const c of COLS) {
    if (c.key === 'stock' && branches.length) {
      for (const b of branches) headers.push({ header: branchHeader(b), key: `branch:${b.id}`, note: 'Quantity at this branch (whole number). Empty = unchanged.' });
    } else headers.push(c);
  }
  ws.columns = headers.map((h) => ({ header: h.header, key: h.key, width: Math.max(16, Math.min(40, h.header.length + 4)) }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.eachCell((cell, i) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headers[i - 1].required ? 'FFFDE9D9' : 'FFEFEFEF' } };
    if (headers[i - 1].note) cell.note = headers[i - 1].note;
  });
  return ws;
}

async function buildWorkbook(db, restaurant, { template = false } = {}) {
  const branches = inventory.activeBranches(db, restaurant.id);
  const categories = db.prepare('SELECT * FROM categories WHERE restaurant_id = ? ORDER BY sort_order, name').all(restaurant.id);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Foodies';
  wb.created = new Date();
  const ws = dishesSheet(wb, branches);
  if (!template) {
    const catName = new Map(categories.map((c) => [c.id, c.name_en || c.name]));
    const products = db.prepare('SELECT * FROM products WHERE restaurant_id = ? ORDER BY name, id').all(restaurant.id);
    const stock = new Map();
    for (const b of branches) stock.set(b.id, inventory.stockRows(db, restaurant.id, b.id, 'dish'));
    for (const p of products) {
      const row = {
        id: p.id, nameAr: guard(p.name_ar || ''), nameEn: guard(p.name_en || p.name), descriptionAr: guard(p.description_ar || ''), descriptionEn: guard(p.description_en || p.description || ''),
        category: guard(catName.get(p.category_id) || ''),
        original: money(p.original_price_cents ?? p.price_cents), discounted: p.original_price_cents !== null && p.original_price_cents > p.price_cents ? money(p.price_cents) : null,
        available: p.is_available ? 'yes' : 'no', track: p.track_stock ? 'yes' : 'no',
        stock: branches.length ? undefined : (p.track_stock ? p.stock_quantity : null), image: guard(p.image_url || ''),
      };
      for (const b of branches) { const r = stock.get(b.id).get(p.id); row[`branch:${b.id}`] = p.track_stock && r ? r.quantity : null; }
      ws.addRow(row);
    }
    ws.getColumn('original').numFmt = '0.00';
    ws.getColumn('discounted').numFmt = '0.00';
  }
  addInstructions(wb, branches);
  addReferenceSheets(wb, categories, branches);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------- reading the upload
// Reads the ZIP central directory (without inflating anything) and refuses archives that claim to expand beyond MAX_UNZIPPED.
function inspectZip(buf) {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw bad('not_xlsx', 'The file is not an Excel (.xlsx) workbook');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw bad('not_xlsx', 'The file is not an Excel (.xlsx) workbook');
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (entries > 500) throw bad('too_large', 'The workbook is too complex');
  let total = 0;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('not_xlsx', 'The file is not an Excel (.xlsx) workbook');
    total += buf.readUInt32LE(p + 24);
    if (total > MAX_UNZIPPED) throw bad('too_large', 'The workbook is too large');
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
}

function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return { date: true };
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((x) => x.text).join('');
    if ('result' in v) return cellValue(v.result);
    if ('text' in v) return cellValue(v.text);
    if ('error' in v) return { error: true };
    return '';
  }
  return v;
}

// Some tools (the .NET Open XML SDK, some online editors) write valid workbooks whose XML uses a prefix for the spreadsheet namespace
// (<x:workbook>) and a byte-order mark; ExcelJS only understands the unprefixed form. This rewrites such a file into the plain form (same
// content, nothing is executed or fetched) so it can be read. Returns null when there is nothing to rewrite.
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
async function normalizeXlsx(buffer) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  let changed = false;
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || !/\.(xml|rels|vml)$/i.test(name)) continue;
    let text = await zip.file(name).async('string');
    const orig = text;
    text = text.replace(/^\uFEFF/, '');
    const m = new RegExp(`xmlns:([A-Za-z_][\\w.-]*)="${MAIN_NS}"`).exec(text);
    if (m && !/<[A-Za-z_][\w.-]*[^>]*\sxmlns="/.test(text.slice(0, 400))) {
      const p = m[1];
      text = text.replace(new RegExp(`<(/?)${p}:`, 'g'), '<$1').replace(new RegExp(`xmlns:${p}="${MAIN_NS}"`), `xmlns="${MAIN_NS}"`);
    }
    if (/\.rels$/i.test(name)) {
      // cell notes (header hints) are not needed to read the data, and ExcelJS only understands Excel's own file naming for them
      text = text.replace(/<Relationship\b[^>]*\/relationships\/(?:comments|vmlDrawing)"[^>]*\/>/g, '');
    }
    if (/\.rels$/i.test(name)) { // absolute targets ("/xl/styles.xml") -> relative to the part that owns the relationship file
      const owner = require('node:path').posix.dirname(name.replace(/_rels\/[^/]*$/, 'x'));
      text = text.replace(/Target="\/([^"]+)"/g, (all, target) => `Target="${require('node:path').posix.relative(owner === '.' ? '' : owner, target) || target}"`);
    }
    if (text !== orig) { zip.file(name, text); changed = true; }
  }
  return changed ? zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) : null;
}

async function loadWorkbook(buffer) {
  const attempt = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); if (!wb.worksheets.length) throw new Error('no sheets'); return wb; };
  try { return await attempt(buffer); } catch { /* try the normalised form below */ }
  try {
    const fixed = await normalizeXlsx(buffer);
    if (fixed) return await attempt(fixed);
  } catch { /* fall through */ }
  throw bad('unreadable', 'The file could not be read as an Excel workbook');
}

async function readSheet(buffer) {
  inspectZip(buffer);
  const wb = await loadWorkbook(buffer);
  const ws = wb.getWorksheet(SHEET) || wb.worksheets[0];
  if (!ws) throw bad('no_sheet', 'The workbook has no sheet');
  if (ws.actualRowCount > MAX_ROWS + 1) throw bad('too_many_rows', `The sheet has more than ${MAX_ROWS} rows`, { max: MAX_ROWS });
  if (ws.actualColumnCount > MAX_COLS) throw bad('too_many_columns', 'The sheet has too many columns');
  const head = ws.getRow(1);
  const headers = [];
  head.eachCell({ includeEmpty: false }, (cell, col) => { headers[col] = String(cellValue(cell.value) || '').trim(); });
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const cells = {};
    let any = false;
    headers.forEach((h, col) => {
      if (!h) return;
      const v = cellValue(row.getCell(col).value);
      cells[col] = typeof v === 'string' ? unguard(v.trim()) : v;
      if (cells[col] !== '' && cells[col] !== null) any = true;
    });
    if (any) rows.push({ n, cells });
  });
  return { headers, rows };
}

// ---------------------------------------------------------------- cell parsers (each returns { value } or { error: code })
const text = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : null);
function parseMoney(v) {
  if (v === '' || v === null) return { value: null };
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return { error: 'invalid_number' };
    const c = Math.round(v * 100);
    if (Math.abs(v * 100 - c) > 1e-6) return { error: 'too_many_decimals' };
    return c > MAX_PRICE_CENTS ? { error: 'out_of_range' } : { value: c };
  }
  const s = text(v)?.replace(/[٠-٩٫]/g, (d) => ARABIC_DIGITS[d]).replace(',', '.');
  const m = s && /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return /^\d+\.\d{3,}$/.test(s || '') ? { error: 'too_many_decimals' } : { error: 'invalid_number' };
  const c = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0);
  return c > MAX_PRICE_CENTS ? { error: 'out_of_range' } : { value: c };
}
function parseInteger(v, max) {
  if (v === '' || v === null) return { value: null };
  const s = typeof v === 'number' ? v : text(v)?.replace(/[٠-٩]/g, (d) => ARABIC_DIGITS[d]);
  const n = typeof s === 'number' ? s : (/^\d{1,12}$/.test(s || '') ? Number(s) : NaN);
  if (!Number.isInteger(n)) return { error: 'invalid_integer' };
  if (n < 0 || n > max) return { error: 'out_of_range' };
  return { value: n };
}
const YES = new Set(['yes', 'y', 'true', '1', 'available', 'نعم', 'متاح']);
const NO = new Set(['no', 'n', 'false', '0', 'unavailable', 'لا', 'غير متاح']);
function parseYesNo(v) {
  if (v === '' || v === null) return { value: null };
  if (typeof v === 'boolean') return { value: v };
  const s = String(v).trim().toLowerCase();
  if (YES.has(s)) return { value: true };
  if (NO.has(s)) return { value: false };
  return { error: 'invalid_boolean' };
}

// ---------------------------------------------------------------- analysis (no writes)
const MESSAGES = {
  required: 'is required', too_long: 'is too long', invalid_number: 'must be a plain number', too_many_decimals: 'must have at most 2 decimals', out_of_range: 'is out of range',
  invalid_integer: 'must be a whole number', invalid_boolean: 'must be yes or no', discount_not_positive: 'must be greater than zero', discount_not_lower: 'must be lower than the original price',
  unknown_category: 'is not one of your categories', unknown_id: 'is not a dish of your restaurant', id_required: 'is required to update a dish', id_not_allowed: 'must be empty when creating dishes',
  duplicate_in_file: 'appears more than once in the file', invalid_image_url: 'must be an https URL or an uploaded image path', stock_requires_tracking: 'needs Track Stock = yes',
  use_branch_columns: 'is not used when the restaurant has branches: fill the branch stock columns', invalid_value: 'is not a valid value', invalid_id: 'must be a whole number',
  plan_limit: 'would exceed your plan limit',
};
const err = (field, code, extra) => ({ field, code, message: `${field} ${MESSAGES[code] || code}`, ...(extra || {}) });

function mapColumns(headers, branches) {
  const byKey = {}; // key -> column index
  const branchCols = []; // { col, branch }
  const ignored = [];
  const headerErrors = [];
  headers.forEach((h, col) => {
    if (!h) return;
    const bm = BRANCH_HEADER.exec(h);
    if (bm) {
      const b = branches.find((x) => x.id === Number(bm[1]));
      if (!b) headerErrors.push({ field: h, code: 'unknown_branch', message: `${h} refers to a branch that is not yours or is not active` });
      else if (branchCols.some((x) => x.branch.id === b.id)) headerErrors.push({ field: h, code: 'duplicate_column', message: `${h} appears twice` });
      else branchCols.push({ col, branch: b, header: h });
      return;
    }
    const n = norm(h);
    const c = COLS.find((x) => x.aliases.includes(n));
    if (!c) ignored.push(h); else if (byKey[c.key] !== undefined) headerErrors.push({ field: h, code: 'duplicate_column', message: `${h} appears twice` }); else byKey[c.key] = col;
  });
  return { byKey, branchCols, ignored, headerErrors };
}

async function analyze(db, restaurantId, buffer, { mode = 'create' } = {}) {
  if (!['create', 'update'].includes(mode)) throw bad('invalid_mode', 'mode must be create or update');
  const { headers, rows } = await readSheet(buffer);
  const branches = inventory.activeBranches(db, restaurantId);
  const { byKey, branchCols, ignored, headerErrors } = mapColumns(headers, branches);
  for (const c of COLS) {
    if ((c.required || (mode === 'update' && c.key === 'id')) && byKey[c.key] === undefined) headerErrors.push({ field: c.header, code: 'missing_column', message: `The column "${c.header}" is missing` });
  }
  const report = {
    mode, headerErrors, ignoredColumns: ignored, branchColumns: branchCols.map((b) => ({ id: b.branch.id, name: b.branch.name })),
    rows: [], totals: { rows: rows.length, ok: 0, errors: 0, skipped: 0 }, creates: 0, updates: 0,
  };
  if (headerErrors.length) return report;

  const categories = db.prepare('SELECT * FROM categories WHERE restaurant_id = ?').all(restaurantId);
  const catIndex = new Map();
  for (const c of categories) for (const n of [c.name, c.name_en, c.name_ar]) if (n) catIndex.set(n.trim().toLowerCase(), c.id);
  const products = db.prepare('SELECT * FROM products WHERE restaurant_id = ?').all(restaurantId);
  const byId = new Map(products.map((p) => [p.id, p]));
  const existingNames = new Set(products.flatMap((p) => [p.name_en, p.name].filter(Boolean).map((n) => n.trim().toLowerCase())));
  const seenNames = new Set();
  const seenIds = new Set();
  const get = (r, key) => (byKey[key] === undefined ? '' : r.cells[byKey[key]] ?? '');

  for (const r of rows) {
    const errors = [];
    const warnings = [];
    const data = {};
    const bad1 = (field, code, extra) => errors.push(err(field, code, extra));
    const h = (key) => COLS.find((c) => c.key === key).header;
    const readText = (key, max) => {
      const v = get(r, key);
      const s = v && typeof v === 'object' ? null : text(v)?.trim();
      if (s === null) { bad1(h(key), 'invalid_value'); return ''; }
      if (!s) { bad1(h(key), 'required'); return ''; }
      if (s.length > max) { bad1(h(key), 'too_long', { max }); return s; }
      return s;
    };
    // identity
    let target = null;
    const rawId = get(r, 'id');
    if (mode === 'update') {
      if (rawId === '' || rawId === null) bad1(h('id'), 'id_required');
      else {
        const id = parseInteger(rawId, 9e15);
        if (id.error || !id.value) bad1(h('id'), 'invalid_id');
        else if (!byId.has(id.value)) bad1(h('id'), 'unknown_id');
        else if (seenIds.has(id.value)) bad1(h('id'), 'duplicate_in_file');
        else { target = byId.get(id.value); seenIds.add(id.value); }
      }
    } else if (rawId !== '' && rawId !== null) bad1(h('id'), 'id_not_allowed');

    data.nameAr = readText('nameAr', 120);
    data.nameEn = readText('nameEn', 120);
    data.descriptionAr = readText('descriptionAr', 1000);
    data.descriptionEn = readText('descriptionEn', 1000);
    // category
    const cat = get(r, 'category');
    data.categoryId = target ? target.category_id : null; // column absent in an update: unchanged
    if (byKey.category !== undefined) data.categoryId = null;
    if (byKey.category !== undefined && cat !== '' && cat !== null) {
      const id = typeof cat === 'string' ? catIndex.get(cat.toLowerCase()) : undefined;
      if (id === undefined) bad1(h('category'), 'unknown_category'); else data.categoryId = id;
    }
    // prices
    const orig = parseMoney(get(r, 'original'));
    if (orig.error) bad1(h('original'), orig.error); else if (orig.value === null) bad1(h('original'), 'required');
    const keepDiscount = byKey.discounted === undefined && target; // column absent in an update: the dish keeps its own discounted price
    const disc = keepDiscount ? { value: target.original_price_cents !== null && target.original_price_cents > target.price_cents ? target.price_cents : null } : parseMoney(get(r, 'discounted'));
    if (disc.error) bad1(h('discounted'), disc.error);
    else if (disc.value !== null && orig.value !== null && !orig.error) {
      if (disc.value <= 0) bad1(h('discounted'), 'discount_not_positive'); else if (disc.value >= orig.value) bad1(keepDiscount ? h('original') : h('discounted'), 'discount_not_lower');
    }
    data.originalCents = orig.value; data.discountedCents = disc.error ? null : disc.value;
    // availability: never published by accident
    const av = byKey.available === undefined && target ? { value: !!target.is_available } : parseYesNo(get(r, 'available'));
    if (av.error) bad1(h('available'), av.error);
    else if (av.value === null) { data.available = false; warnings.push({ field: h('available'), code: 'availability_defaulted' }); } else data.available = av.value;
    // image
    const img = get(r, 'image');
    data.imageUrl = target && byKey.image === undefined ? target.image_url : null;
    if (img !== '' && img !== null) {
      try { data.imageUrl = imageUrl(String(img), 'imageUrl'); } catch { bad1(h('image'), 'invalid_image_url'); }
    }
    // stock
    const tr = parseYesNo(get(r, 'track'));
    if (tr.error) bad1(h('track'), tr.error);
    data.track = tr.error ? null : tr.value; // null = not given
    const effectiveTrack = data.track !== null ? data.track : (target ? !!target.track_stock : false);
    data.stock = null;
    data.branchStock = [];
    if (byKey.stock !== undefined) {
      const q = parseInteger(get(r, 'stock'), MAX_STOCK);
      if (q.error) bad1(h('stock'), q.error);
      else if (q.value !== null) {
        if (branches.length) bad1(h('stock'), 'use_branch_columns'); else if (!effectiveTrack) bad1(h('stock'), 'stock_requires_tracking'); else data.stock = q.value;
      }
    }
    for (const bc of branchCols) {
      const q = parseInteger(r.cells[bc.col] ?? '', MAX_STOCK);
      if (q.error) bad1(bc.header, q.error);
      else if (q.value !== null) {
        if (!effectiveTrack) bad1(bc.header, 'stock_requires_tracking'); else data.branchStock.push({ branchId: bc.branch.id, quantity: q.value });
      }
    }
    // duplicates
    let action = mode === 'update' ? 'update' : 'create';
    const key = data.nameEn.toLowerCase();
    if (mode === 'create' && data.nameEn) {
      if (seenNames.has(key)) bad1(h('nameEn'), 'duplicate_in_file');
      else if (existingNames.has(key) && !errors.length) action = 'skip';
      seenNames.add(key);
    }
    const status = errors.length ? 'error' : action === 'skip' ? 'skipped' : 'ok';
    if (status === 'ok') { report.totals.ok++; if (action === 'create') report.creates++; else report.updates++; } else if (status === 'error') report.totals.errors++; else report.totals.skipped++;
    report.rows.push({
      row: r.n, action, status, name: data.nameEn || data.nameAr, id: target ? target.id : null, errors, warnings,
      ...(status === 'skipped' ? { skipReason: 'duplicate_existing' } : {}),
      data: status === 'error' ? undefined : data, _target: target,
    });
  }
  return report;
}

// What the browser gets: no internal fields.
const publicReport = (rep) => ({
  mode: rep.mode, headerErrors: rep.headerErrors, ignoredColumns: rep.ignoredColumns, branchColumns: rep.branchColumns, totals: rep.totals, creates: rep.creates, updates: rep.updates,
  rows: rep.rows.map((r) => ({ row: r.row, action: r.action, status: r.status, name: r.name, id: r.id, errors: r.errors, warnings: r.warnings, skipReason: r.skipReason })),
});

// ---------------------------------------------------------------- commit
async function commit(db, restaurantId, buffer, { mode = 'create', skipInvalid = false } = {}) {
  const rep = await analyze(db, restaurantId, buffer, { mode });
  if (rep.headerErrors.length || (rep.totals.errors > 0 && !skipInvalid)) {
    throw new HttpError(422, 'import_invalid', 'The file has problems. Nothing was imported.', { report: publicReport(rep) });
  }
  const todo = rep.rows.filter((r) => r.status === 'ok');
  const summary = tx(db, () => {
    if (rep.creates) enforceLimit(db, restaurantId, 'menuItems', rep.creates); // inside the transaction: concurrent imports cannot overshoot
    const branches = inventory.activeBranches(db, restaurantId);
    const upsertStock = (productId, branchId, qty) => {
      const cur = db.prepare('SELECT id FROM branch_stock WHERE branch_id = ? AND product_id = ? AND restaurant_id = ?').get(branchId, productId, restaurantId);
      if (cur) db.prepare("UPDATE branch_stock SET quantity = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND restaurant_id = ?").run(qty, cur.id, restaurantId);
      else db.prepare('INSERT INTO branch_stock (restaurant_id, branch_id, product_id, quantity) VALUES (?,?,?,?)').run(restaurantId, branchId, productId, qty);
    };
    const out = { created: 0, updated: 0, skipped: rep.totals.skipped, failed: rep.totals.errors };
    for (const r of todo) {
      const d = r.data;
      const price = d.discountedCents !== null ? d.discountedCents : d.originalCents;
      const original = d.discountedCents !== null ? d.originalCents : null;
      let pid;
      if (r.action === 'create') {
        const track = d.track ? 1 : 0;
        pid = Number(db.prepare(
          `INSERT INTO products (restaurant_id, category_id, name, description, name_ar, name_en, description_ar, description_en, price_cents, original_price_cents, image_url, is_available, track_stock, stock_quantity)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(restaurantId, d.categoryId, d.nameEn, d.descriptionEn, d.nameAr, d.nameEn, d.descriptionAr, d.descriptionEn, price, original, d.imageUrl, d.available ? 1 : 0, track, branches.length ? 0 : (d.stock ?? 0)).lastInsertRowid);
        out.created++;
      } else {
        pid = r.id;
        const track = d.track === null ? r._target.track_stock : (d.track ? 1 : 0);
        const qty = d.stock !== null ? d.stock : r._target.stock_quantity;
        db.prepare(
          `UPDATE products SET category_id=?, name=?, description=?, name_ar=?, name_en=?, description_ar=?, description_en=?, price_cents=?, original_price_cents=?, image_url=?, is_available=?, track_stock=?, stock_quantity=?
           WHERE id = ? AND restaurant_id = ?`)
          .run(d.categoryId, d.nameEn, d.descriptionEn, d.nameAr, d.nameEn, d.descriptionAr, d.descriptionEn, price, original, d.imageUrl, d.available ? 1 : 0, track, qty, pid, restaurantId);
        out.updated++;
      }
      for (const s of d.branchStock) upsertStock(pid, s.branchId, s.quantity);
    }
    return out;
  });
  return { ...summary, report: publicReport(rep) };
}

module.exports = { XLSX_MIME, MAX_ROWS, buildWorkbook, analyze, commit, publicReport, COLS };
