// js/bank-recon-csv.js
// Parser rekening koran (CSV) — fungsi murni, tanpa DOM/Supabase.
// Dipakai oleh js/bank-recon-page.js dan diuji lewat tools/test-bank-recon-csv.mjs.
//
// Format utama (hasil tools/xlsx-bca-extract.mjs):
//   tanggal;bulan;tipe;keterangan;masuk_debet;keluar_kredit;saldo
//   tipe = OPEN | MUTASI ; bulan = JAN..DES
//
// Konvensi arah dana (sama dengan tabel bank_statement_lines):
//   debit  = uang MASUK ke rekening bank
//   credit = uang KELUAR dari rekening bank
//
// Parser juga menerima header generik (tanggal/date, keterangan/description,
// masuk/debit, keluar/credit, saldo/balance) dengan pemisah ; , atau tab.

const MONTH_NO = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MEI: 5, MAY: 5, JUN: 6, JUNI: 6,
  JUL: 7, JULI: 7, AGT: 8, AGU: 8, AUG: 8, SEP: 9, SEPT: 9, OKT: 10, OCT: 10,
  NOV: 11, DES: 12, DEC: 12
};

const HEADER_ALIASES = {
  date: ['tanggal', 'tgl', 'date', 'transaction date', 'transaction_date', 'tanggal transaksi'],
  month: ['bulan', 'month', 'periode', 'period'],
  type: ['tipe', 'type', 'jenis'],
  description: ['keterangan', 'description', 'uraian', 'remark', 'berita', 'detail', 'keterangan transaksi'],
  debit: ['masuk_debet', 'masuk', 'debit', 'dana masuk', 'uang masuk', 'mutasi masuk', 'debit_masuk'],
  credit: ['keluar_kredit', 'keluar', 'kredit', 'credit', 'dana keluar', 'uang keluar', 'mutasi keluar', 'kredit_keluar'],
  balance: ['saldo', 'balance', 'saldo akhir', 'saldo_akhir'],
  ref: ['referensi', 'ref', 'no_ref', 'no ref', 'reference', 'nomor referensi']
};

// ------------------------------------------------------------
// CSV / delimiter
// ------------------------------------------------------------
export function detectDelimiter(text) {
  const firstLine = String(text || '').replace(/^\ufeff/, '').split(/\r?\n/).find(l => l.trim() !== '') || '';
  const counts = [
    { d: ';', n: (firstLine.match(/;/g) || []).length },
    { d: ',', n: (firstLine.match(/,/g) || []).length },
    { d: '\t', n: (firstLine.match(/\t/g) || []).length }
  ].sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ';';
}

// Ubah teks CSV menjadi array baris (array of cell), sadar tanda kutip.
export function parseDelimited(text, delimiter = null) {
  const src = String(text || '').replace(/^\ufeff/, '');
  const d = delimiter || detectDelimiter(src);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuote = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuote) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else inQuote = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { inQuote = true; continue; }
    if (ch === d) { row.push(cell); cell = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

// ------------------------------------------------------------
// Angka & tanggal
// ------------------------------------------------------------
export function parseAmount(value) {
  if (value === null || value === undefined) return 0;
  let s = String(value).trim();
  if (!s || s === '-') return 0;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(/[^0-9.,\-]/g, '');
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  if (!s) return 0;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // pemisah desimal = yang terakhir
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    // "1,234,567" -> ribuan ; "109,37" -> desimal ; "0,005" tetap desimal
    if ((s.match(/,/g) || []).length > 1 || (decimals === 3 && s.length > 4 && !/^0,/.test(s))) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
  } else if (lastDot >= 0) {
    const decimals = s.length - lastDot - 1;
    if ((s.match(/\./g) || []).length > 1 || (decimals === 3 && s.length > 4 && !/^0\./.test(s))) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (isNaN(n)) return 0;
  return negative ? -n : n;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Kembalikan 'YYYY-MM-DD' atau '' bila tidak dikenali.
export function parseDateValue(value, defaultYear = null) {
  const s = String(value || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
    return '';
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += y < 70 ? 2000 : 1900;
    const d = Number(m[1]), mo = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
    // format US (mm/dd/yyyy) bila hari > 12 tidak mungkin
    if (d >= 1 && d <= 12 && mo >= 1 && mo <= 31) return `${y}-${pad2(d)}-${pad2(mo)}`;
    return '';
  }
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,})[\s-](\d{2,4})/); // 05 Jan 2026
  if (m) {
    const mo = MONTH_NO[m[2].slice(0, 4).toUpperCase()] || MONTH_NO[m[2].slice(0, 3).toUpperCase()];
    if (mo) {
      let y = Number(m[3]);
      if (y < 100) y += y < 70 ? 2000 : 1900;
      return `${y}-${pad2(mo)}-${pad2(Number(m[1]))}`;
    }
  }
  if (defaultYear) {
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})$/);
    if (m) return `${defaultYear}-${pad2(Number(m[2]))}-${pad2(Number(m[1]))}`;
  }
  return '';
}

// ------------------------------------------------------------
// Parser utama
// ------------------------------------------------------------
function normHeader(h) {
  return String(h || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function mapHeader(headers) {
  const norm = headers.map(normHeader);
  const idx = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const at = norm.findIndex(h => aliases.includes(h));
    if (at >= 0) idx[key] = at;
  }
  return idx;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function monthNameFromIso(iso) {
  const names = ['JAN', 'FEB', 'MAR', 'APR', 'MEI', 'JUN', 'JUL', 'AGT', 'SEPT', 'OKT', 'NOV', 'DES'];
  const mo = Number(String(iso).slice(5, 7));
  return names[mo - 1] || '';
}

/**
 * @param {string} text isi file CSV
 * @param {{defaultYear?:number}} [opts]
 * @returns {{lines:Array, header:Object, warnings:string[], delimiter:string}}
 */
export function parseBankStatementCsv(text, opts = {}) {
  const trimmed = String(text || '').replace(/^\ufeff/, '').trim();
  if (!trimmed) throw new Error('File CSV kosong.');

  const delim = detectDelimiter(trimmed);
  const rows = parseDelimited(trimmed, delim);
  if (!rows.length) throw new Error('File CSV kosong.');

  const header = mapHeader(rows[0]);
  if (header.date === undefined && header.description === undefined) {
    throw new Error(`Header tidak dikenal: ${rows[0].join(delim)}. Gunakan kolom tanggal, keterangan, masuk/debit, keluar/credit, saldo.`);
  }
  if (header.debit === undefined && header.credit === undefined && header.balance === undefined) {
    throw new Error('Kolom nominal tidak ditemukan. Butuh masuk/debit, keluar/credit, atau saldo.');
  }

  const warnings = [];
  const raw = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const cell = k => (header[k] !== undefined ? String(r[header[k]] ?? '').trim() : '');
    raw.push({
      rowNo: i + 1,
      dateRaw: cell('date'),
      monthRaw: cell('month').toUpperCase().replace(/\./g, ''),
      typeRaw: cell('type').toUpperCase(),
      description: cell('description') || '(tanpa keterangan)',
      debit: header.debit !== undefined ? parseAmount(cell('debit')) : 0,
      credit: header.credit !== undefined ? parseAmount(cell('credit')) : 0,
      balanceRaw: cell('balance'),
      balance: header.balance !== undefined && cell('balance') !== '' ? parseAmount(cell('balance')) : null,
      ref: cell('ref') || null
    });
  }
  if (!raw.length) throw new Error('File CSV tidak berisi baris data.');

  // Buang baris "OPEN SALDO AWAL" di ekor file yang belum punya mutasi
  // (tanggal & nominal kosong, saldo kosong/nol) — mis. sheet OKT/NOV 2026.
  while (raw.length > 1) {
    const last = raw[raw.length - 1];
    const tailPlaceholder = last.typeRaw === 'OPEN' && last.dateRaw === ''
      && last.debit === 0 && last.credit === 0
      && (last.balanceRaw === '' || last.balance === 0);
    if (!tailPlaceholder) break;
    warnings.push(`Baris ${last.rowNo}: saldo awal tanpa mutasi (${last.description}) dilewati.`);
    raw.pop();
  }

  // Tahun acuan: tahun dari baris terakhir yang punya tanggal (sama dengan
  // generator SQL), fallback opts.defaultYear / tahun sekarang.
  let yearRef = null;
  for (let i = raw.length - 1; i >= 0; i--) {
    const iso = parseDateValue(raw[i].dateRaw);
    if (iso) { yearRef = Number(iso.slice(0, 4)); break; }
  }
  if (!yearRef) yearRef = Number(opts.defaultYear) || new Date().getFullYear();

  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    let date = parseDateValue(r.dateRaw, yearRef);
    const isOpening = r.typeRaw === 'OPEN'
      || (r.typeRaw === '' && r.debit === 0 && r.credit === 0 && /saldo awal/i.test(r.description));

    if (!date) {
      const mo = MONTH_NO[r.monthRaw];
      if (mo) {
        date = `${yearRef}-${pad2(mo)}-01`;
      } else {
        date = `${yearRef}-01-01`;
        warnings.push(`Baris ${r.rowNo}: tanggal kosong & bulan tidak dikenali -> dipakai ${date}.`);
      }
    }

    let balance = r.balance;
    if (balance === null) {
      const prev = lines[i - 1];
      balance = prev ? round2(prev.balance + r.debit - r.credit) : round2(r.debit - r.credit);
      warnings.push(`Baris ${r.rowNo}: saldo kosong -> dihitung ${balance}.`);
    }

    lines.push({
      line_no: i + 1,
      line_date: date,
      period_month: r.monthRaw || monthNameFromIso(date),
      entry_type: isOpening ? 'opening' : 'mutation',
      description: r.description,
      debit: round2(r.debit),
      credit: round2(r.credit),
      balance: round2(balance),
      ref: r.ref
    });
  }

  return { lines, header, warnings, delimiter: delim };
}

// ------------------------------------------------------------
// Rekap & uji rantai saldo
// ------------------------------------------------------------
export function summarizeStatement(lines) {
  const rows = Array.isArray(lines) ? lines : [];
  const mutations = rows.filter(r => r.entry_type === 'mutation');
  const openingRow = rows[0] || null;
  const closingRow = rows.length ? rows[rows.length - 1] : null;
  const totalMasuk = round2(mutations.reduce((a, r) => a + r.debit, 0));
  const totalKeluar = round2(mutations.reduce((a, r) => a + r.credit, 0));
  const opening = openingRow ? round2(openingRow.balance) : 0;
  const closing = closingRow ? round2(closingRow.balance) : 0;

  let run = opening;
  let breaks = 0;
  for (const r of rows.slice(1)) {
    if (r.entry_type === 'opening') {
      if (Math.abs(run - r.balance) > 0.005) breaks++;
      run = r.balance;
      continue;
    }
    run = round2(run + r.debit - r.credit);
    if (Math.abs(run - r.balance) > 0.005) breaks++;
  }

  const selisih = round2(opening + totalMasuk - totalKeluar - closing);
  const dates = rows.map(r => r.line_date).filter(Boolean).sort();

  return {
    rows: rows.length,
    nOpen: rows.length - mutations.length,
    nMutasi: mutations.length,
    opening,
    closing,
    totalMasuk,
    totalKeluar,
    selisih,
    breaks,
    periodStart: dates[0] || null,
    periodEnd: dates[dates.length - 1] || null
  };
}
