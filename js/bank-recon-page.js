// js/bank-recon-page.js
// Halaman Rekonsiliasi Bank: upload CSV rekening koran, pratinjau, import ke
// bank_statement_imports / bank_statement_lines, cocokkan otomatis (RPC),
// tautkan manual / lepas / abaikan baris, ubah status file.
import { supabase } from './supabase-client.js';
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission, preloadPermissions } from './permissions.js';
import { parseBankStatementCsv, summarizeStatement } from './bank-recon-csv.js';

// ============================================================
// UTIL
// ============================================================
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => el.className = 'toast', 3200);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function fmt(n) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  if (isNaN(num)) return '—';
  return num.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Mata uang rekening: baris view sudah membawa currency_code (v11.2).
function normCurrency(cur) {
  const c = String(cur || 'IDR').trim().toUpperCase();
  return c || 'IDR';
}
// fmt + label mata uang untuk nilai non-IDR (IDR tetap polos seperti sebelumnya).
function fmtMoney(n, cur) {
  const txt = fmt(n);
  if (txt === '—') return txt;
  const c = normCurrency(cur);
  return c === 'IDR' ? txt : `${c} ${txt}`;
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(String(d).slice(0, 10) + 'T00:00:00');
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}
function dayDiff(a, b) {
  const da = new Date(String(a).slice(0, 10) + 'T00:00:00');
  const db = new Date(String(b).slice(0, 10) + 'T00:00:00');
  if (isNaN(da) || isNaN(db)) return null;
  return Math.round((da - db) / 86400000);
}
function matchBadge(s) {
  const map = {
    unmatched: { bg: '#fee2e2', color: '#991b1b', label: 'Belum cocok' },
    auto:      { bg: '#dbeafe', color: '#1e40af', label: 'Otomatis' },
    manual:    { bg: '#d1fae5', color: '#065f46', label: 'Manual' },
    ignored:   { bg: '#e5e7eb', color: '#4b5563', label: 'Diabaikan' }
  };
  const m = map[s] || { bg: '#f3f4f6', color: '#6b7280', label: s || '—' };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:${m.bg};color:${m.color};">${esc(m.label)}</span>`;
}
function importBadge(s) {
  const map = {
    imported:   { bg: '#fef3c7', color: '#92400e', label: 'Imported' },
    verified:   { bg: '#dbeafe', color: '#1e40af', label: 'Verified' },
    reconciled: { bg: '#d1fae5', color: '#065f46', label: 'Reconciled' }
  };
  const m = map[s] || { bg: '#f3f4f6', color: '#6b7280', label: s || '—' };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:${m.bg};color:${m.color};">${esc(m.label)}</span>`;
}

// ============================================================
// STATE
// ============================================================
const PAGE_SIZE = 50;
const state = {
  activeTab: 'ringkasan',
  canView: false,
  canImport: false,
  canRecon: false,
  imports: [],
  lines: [],
  lineTotal: 0,
  page: 1,
  filters: { import_id: '', status: '', search: '', from: '', to: '' },
  preview: null,
  candidateLine: null,
  candidates: []
};

// ============================================================
// TAB RINGKASAN
// ============================================================
async function loadImports() {
  const { data, error } = await supabase
    .from('v_bank_recon_summary')
    .select('*')
    .order('period_end', { ascending: false })
    .order('import_id', { ascending: false });
  if (error) { toast('Gagal memuat file rekening koran: ' + error.message, true); return; }
  state.imports = data || [];
  renderImports();
  renderSummary();
  fillImportFilter();
}

function renderSummary() {
  const rows = state.imports;
  const last = rows[0] || null;
  const cur = last ? normCurrency(last.currency_code) : 'IDR';
  document.getElementById('sumSaldoKoran').textContent = last ? fmtMoney(last.closing_balance, cur) : '—';
  document.getElementById('sumSaldoGl').textContent = last ? fmtMoney(last.saldo_gl, cur) : '—';
  document.getElementById('sumSelisihGl').textContent = last ? fmtMoney(last.selisih_gl_vs_bank, cur) : '—';
  document.getElementById('sumSaldoGlLabel').textContent = last ? last.coa_code : '1-11xx';
  document.getElementById('sumSaldoKoranCurrency').textContent = last ? cur : '';
  document.getElementById('sumSaldoGlCurrency').textContent = last ? cur : '';
  const unmatched = rows.reduce((a, r) => a + Number(r.baris_unmatched || 0), 0);
  document.getElementById('sumUnmatched').textContent = String(unmatched);
  document.getElementById('sumImports').textContent = String(rows.length);
}

function renderImports() {
  const tbody = document.getElementById('tbody-imports');
  if (!state.imports.length) {
    tbody.innerHTML = '<tr><td colspan="15" style="text-align:center;color:#9ca3af;padding:16px;">Belum ada file rekening koran. Buka tab Import CSV.</td></tr>';
    return;
  }
  tbody.innerHTML = state.imports.map(r => {
    const selisih = Number(r.selisih_saldo || 0);
    const selisihGl = Number(r.selisih_gl_vs_bank || 0);
    const cur = normCurrency(r.currency_code);
    const curTag = cur === 'IDR'
      ? ''
      : ` <span style="font-size:11px;color:#1e40af;background:#dbeafe;border-radius:999px;padding:1px 6px;">${esc(cur)}</span>`;
    const actions = [
      `<button type="button" class="btn btn-secondary" data-act="view" data-id="${r.import_id}" style="padding:3px 8px;font-size:11px;">Baris</button>`
    ];
    if (state.canRecon) {
      actions.push(`<button type="button" class="btn btn-secondary" data-act="auto" data-id="${r.import_id}" style="padding:3px 8px;font-size:11px;">Auto</button>`);
      if (r.status !== 'reconciled') {
        actions.push(`<button type="button" class="btn btn-primary" data-act="reconcile" data-id="${r.import_id}" style="padding:3px 8px;font-size:11px;">Tutup</button>`);
      }
      actions.push(`<button type="button" class="btn btn-danger" data-act="delete" data-id="${r.import_id}" style="padding:3px 8px;font-size:11px;">Hapus</button>`);
    }
    return `<tr>
      <td>${esc(r.file_name)}</td>
      <td>${esc(r.coa_code)} ${esc(r.coa_name || '')}${curTag}</td>
      <td>${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}</td>
      <td class="num">${fmtMoney(r.opening_balance, cur)}</td>
      <td class="num">${fmtMoney(r.total_masuk, cur)}</td>
      <td class="num">${fmtMoney(r.total_keluar, cur)}</td>
      <td class="num">${fmtMoney(r.closing_balance, cur)}</td>
      <td class="num" style="color:${Math.abs(selisih) > 0.005 ? '#dc2626' : '#065f46'};">${fmtMoney(selisih, cur)}</td>
      <td class="num">${Number(r.baris_matched || 0)}</td>
      <td class="num">${Number(r.baris_unmatched || 0)}</td>
      <td class="num">${Number(r.baris_ignored || 0)}</td>
      <td class="num">${fmtMoney(r.saldo_gl, cur)}</td>
      <td class="num" style="color:${Math.abs(selisihGl) > 0.005 ? '#dc2626' : '#065f46'};">${fmtMoney(selisihGl, cur)}</td>
      <td>${importBadge(r.status)}</td>
      <td style="white-space:nowrap;">${actions.join(' ')}</td>
    </tr>`;
  }).join('');
}

// ============================================================
// TAB BARIS REKENING KORAN
// ============================================================
function fillImportFilter() {
  const sel = document.getElementById('fImport');
  const current = state.filters.import_id;
  sel.innerHTML = '<option value="">Semua file</option>' + state.imports.map(r => {
    const cur = normCurrency(r.currency_code);
    const tag = cur === 'IDR' ? '' : ` · ${esc(cur)}`;
    return `<option value="${r.import_id}">${esc(r.file_name)} (${esc(r.coa_code)}${tag})</option>`;
  }).join('');
  sel.value = current;
  if (sel.value !== current) { sel.value = ''; state.filters.import_id = ''; }

  const coaSel = document.getElementById('impCoa');
  if (coaSel && !coaSel.dataset.loaded) loadBankAccounts();
}

async function loadBankAccounts() {
  const sel = document.getElementById('impCoa');
  if (!sel) return;
  sel.dataset.loaded = '1';
  const { data, error } = await supabase
    .from('accounts')
    .select('code, name')
    .like('code', '1-11%')
    .order('code');
  if (error) { sel.innerHTML = '<option value="">(gagal memuat akun)</option>'; return; }
  sel.innerHTML = (data || []).map(a => `<option value="${esc(a.code)}">${esc(a.code)} — ${esc(a.name)}</option>`).join('');
  await suggestCurrencyForAccount(sel.value);
}

// v11.2: tentukan mata uang file dari import sebelumnya atau riwayat jurnal.
// Rekening valas punya jurnal mata uang asli (mis. USD), sedangkan rekening
// IDR hanya punya jurnal IDR. Deteksi ini mencegah file USD diimpor sebagai IDR.
async function suggestCurrencyForAccount(coa) {
  const sel = document.getElementById('impCurrency');
  if (!sel || !coa) return;
  const prev = state.imports.find(r => r.coa_code === coa);
  if (prev) {
    sel.value = normCurrency(prev.currency_code);
    return;
  }
  const { data: acc, error: accErr } = await supabase
    .from('accounts').select('id').eq('code', coa).single();
  if (accErr || !acc) return;
  const { data: jls } = await supabase
    .from('journal_lines')
    .select('journal_id, journals(currency_code)')
    .eq('account_id', acc.id)
    .limit(200);
  const counts = new Map();
  for (const row of jls || []) {
    const rel = Array.isArray(row.journals) ? row.journals[0] : row.journals;
    const c = normCurrency(rel && rel.currency_code);
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const foreign = [...counts.entries()]
    .filter(([c]) => c !== 'IDR')
    .sort((a, b) => b[1] - a[1]);
  if (foreign.length) {
    sel.value = foreign[0][0];
    const statusEl = document.getElementById('impStatus');
    if (statusEl) statusEl.textContent =
      `Mata uang akun ${coa} terdeteksi ${foreign[0][0]} dari riwayat jurnal.`;
  } else {
    sel.value = 'IDR';
  }
}

async function loadLines() {
  const tbody = document.getElementById('tbody-lines');
  tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#9ca3af;padding:16px;">Memuat...</td></tr>';

  const f = state.filters;
  let q = supabase.from('v_bank_recon').select('*', { count: 'exact' });
  if (f.import_id) q = q.eq('import_id', Number(f.import_id));
  if (f.status) q = q.eq('match_status', f.status);
  if (f.from) q = q.gte('line_date', f.from);
  if (f.to) q = q.lte('line_date', f.to);
  if (f.search.trim()) {
    const s = f.search.trim().replace(/[%,]/g, ' ');
    q = q.or(`description.ilike.%${s}%,journal_no.ilike.%${s}%`);
  }
  const from = (state.page - 1) * PAGE_SIZE;
  q = q.order('line_date', { ascending: true }).order('line_no', { ascending: true }).range(from, from + PAGE_SIZE - 1);

  const { data, error, count } = await q;
  if (error) {
    toast('Gagal memuat baris: ' + error.message, true);
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#dc2626;padding:16px;">Gagal memuat data.</td></tr>';
    return;
  }
  state.lines = data || [];
  state.lineTotal = count || 0;
  renderLines();
}

function renderLines() {
  const tbody = document.getElementById('tbody-lines');
  if (!state.lines.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#9ca3af;padding:16px;">Tidak ada baris yang cocok dengan filter.</td></tr>';
  } else {
    tbody.innerHTML = state.lines.map(l => {
      const masuk = Number(l.masuk || 0);
      const keluar = Number(l.keluar || 0);
      const cur = normCurrency(l.currency_code);
      const acts = [];
      if (state.canRecon) {
        if (l.match_status === 'unmatched' || l.match_status === 'ignored') {
          acts.push(`<button type="button" class="btn btn-secondary" data-act="link" data-id="${l.id}" style="padding:3px 8px;font-size:11px;">Tautkan</button>`);
        }
        if (l.match_status === 'auto' || l.match_status === 'manual') {
          acts.push(`<button type="button" class="btn btn-secondary" data-act="unlink" data-id="${l.id}" style="padding:3px 8px;font-size:11px;">Lepas</button>`);
        }
        if (l.match_status === 'ignored') {
          acts.push(`<button type="button" class="btn btn-secondary" data-act="unignore" data-id="${l.id}" style="padding:3px 8px;font-size:11px;">Batal abaikan</button>`);
        } else if (l.match_status === 'unmatched') {
          acts.push(`<button type="button" class="btn btn-secondary" data-act="ignore" data-id="${l.id}" style="padding:3px 8px;font-size:11px;">Abaikan</button>`);
        }
      }
      const jurnal = l.journal_no
        ? `${esc(l.journal_no)}<br><span style="font-size:11px;color:#6b7280;">${fmtDate(l.journal_date)}</span>`
        : '<span style="color:#9ca3af;">—</span>';
      return `<tr>
        <td>${l.line_no}</td>
        <td>${fmtDate(l.line_date)}</td>
        <td title="${esc(l.description)}">${esc(l.description || '')}</td>
        <td>${l.arah === 'IN' ? 'Masuk' : 'Keluar'}</td>
        <td class="num">${masuk ? fmtMoney(masuk, cur) : '—'}</td>
        <td class="num">${keluar ? fmtMoney(keluar, cur) : '—'}</td>
        <td class="num">${fmtMoney(l.balance, cur)}</td>
        <td>${matchBadge(l.match_status)}</td>
        <td>${jurnal}</td>
        <td style="white-space:nowrap;">${acts.join(' ')}</td>
      </tr>`;
    }).join('');
  }

  const totalPages = Math.max(1, Math.ceil(state.lineTotal / PAGE_SIZE));
  document.getElementById('linesInfo').textContent =
    state.lineTotal
      ? `Halaman ${state.page} dari ${totalPages} — ${state.lineTotal} baris`
      : 'Tidak ada data';
  document.getElementById('prevPageBtn').disabled = state.page <= 1;
  document.getElementById('nextPageBtn').disabled = state.page >= totalPages;
}

// ============================================================
// AKSI BARIS (link / unlink / ignore / auto-match)
// ============================================================
async function updateLine(id, patch) {
  const { error } = await supabase
    .from('bank_statement_lines')
    .update(patch)
    .eq('id', Number(id));
  if (error) { toast('Gagal menyimpan: ' + error.message, true); return false; }
  return true;
}

async function unlinkLine(id) {
  const ok = await updateLine(id, {
    matched_journal_line_id: null,
    match_status: 'unmatched',
    matched_at: null
  });
  if (!ok) return;
  toast('Tautan dilepas.');
  await Promise.all([loadLines(), loadImports()]);
}

async function ignoreLine(id, ignore) {
  const ok = await updateLine(id, {
    matched_journal_line_id: null,
    match_status: ignore ? 'ignored' : 'unmatched',
    matched_at: null
  });
  if (!ok) return;
  toast(ignore ? 'Baris diabaikan.' : 'Baris dikembalikan ke belum cocok.');
  await Promise.all([loadLines(), loadImports()]);
}

async function autoMatch(importId = null) {
  const btn = document.getElementById('autoMatchBtn');
  if (btn) btn.disabled = true;
  const { data, error } = await supabase.rpc('auto_match_bank_lines', {
    p_import_id: importId ? Number(importId) : null,
    p_day_window: 3
  });
  if (btn) btn.disabled = false;
  if (error) { toast('Auto-match gagal: ' + error.message, true); return; }
  const r = data || {};
  toast(`Auto-match: ${r.matched ?? 0} cocok, ${r.no_gl_candidate ?? 0} tanpa kandidat GL, sisa ${r.unmatched_left ?? 0} belum cocok.`);
  await Promise.all([loadLines(), loadImports()]);
}

async function openLinkModal(lineId) {
  const line = state.lines.find(l => String(l.id) === String(lineId));
  if (!line) return;
  state.candidateLine = line;
  state.candidates = [];

  const modal = document.getElementById('linkModal');
  const tbody = document.getElementById('tbody-candidates');
  const amount = Number(line.amount || (Number(line.masuk) > 0 ? line.masuk : line.keluar));
  const arah = line.arah; // IN = uang masuk bank -> cari sisi KREDIT GL
  const cur = normCurrency(line.currency_code);
  const isIdr = cur === 'IDR';
  document.getElementById('linkHeader').innerHTML =
    `Baris #${line.line_no} · ${fmtDate(line.line_date)} · ${esc(line.description || '')} · ` +
    `<b>${arah === 'IN' ? 'Masuk' : 'Keluar'} ${fmtMoney(amount, cur)}</b> · akun ${esc(line.coa_code)}` +
    (isIdr ? '' : ` · <b>${esc(cur)}</b>`);
  modal.style.display = 'flex';
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#9ca3af;padding:16px;">Mencari kandidat jurnal...</td></tr>';

  const { data: acc, error: accErr } = await supabase
    .from('accounts').select('id, code, name').eq('code', line.coa_code).single();
  if (accErr || !acc) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#dc2626;padding:16px;">Akun bank tidak ditemukan di COA.</td></tr>';
    return;
  }

  // v11.2: IDR -> bandingkan kolom base (v11.1); valas -> nominal mata uang asli.
  const amountCol = arah === 'IN'
    ? (isIdr ? 'credit_base' : 'credit')
    : (isIdr ? 'debit_base' : 'debit');
  const { data: jls, error: jlErr } = await supabase
    .from('journal_lines')
    .select('id, journal_id, memo, debit, credit, debit_base, credit_base')
    .eq('account_id', acc.id)
    .eq(amountCol, amount);
  if (jlErr) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#dc2626;padding:16px;">${esc(jlErr.message)}</td></tr>`;
    return;
  }
  if (!jls || !jls.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#9ca3af;padding:16px;">Tidak ada baris jurnal dengan nominal tersebut pada akun ini.</td></tr>';
    return;
  }

  const { data: used } = await supabase
    .from('bank_statement_lines')
    .select('matched_journal_line_id, match_status')
    .not('matched_journal_line_id', 'is', null)
    .in('match_status', ['auto', 'manual']);
  const usedSet = new Set((used || []).map(u => String(u.matched_journal_line_id)));

  const { data: jhs, error: jhErr } = await supabase
    .from('journals')
    .select('id, journal_no, journal_date, description, currency_code')
    .in('id', jls.map(j => j.journal_id));
  if (jhErr) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#dc2626;padding:16px;">${esc(jhErr.message)}</td></tr>`;
    return;
  }
  const hmap = new Map((jhs || []).map(h => [String(h.id), h]));

  let rows = jls.map(j => {
    const h = hmap.get(String(j.journal_id)) || {};
    return {
      id: j.id,
      journal_no: h.journal_no || `#${j.journal_id}`,
      journal_date: h.journal_date || null,
      description: h.description || '',
      memo: j.memo || '',
      currency_code: normCurrency(h.currency_code),
      debit_cmp: Number((isIdr ? j.debit_base : j.debit) || 0),
      credit_cmp: Number((isIdr ? j.credit_base : j.credit) || 0),
      debit_idr: Number(j.debit_base || 0),
      credit_idr: Number(j.credit_base || 0),
      diff: h.journal_date ? dayDiff(h.journal_date, line.line_date) : null,
      used: usedSet.has(String(j.id))
    };
  });
  // Hanya jurnal dengan mata uang yang sama (rekening valas vs jurnal valas).
  // Rekening IDR tetap memakai semua jurnal seperti v11.1 (nilai base IDR).
  const currencyRows = isIdr ? rows : rows.filter(r => r.currency_code === cur);
  if (!currencyRows.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#9ca3af;padding:16px;">` +
      `Nominal sama ada, tetapi mata uang jurnalnya bukan ${esc(cur)}.</td></tr>`;
    return;
  }
  rows = currencyRows.filter(r => r.diff === null || Math.abs(r.diff) <= 90);
  rows.sort((a, b) => Math.abs(a.diff ?? 9999) - Math.abs(b.diff ?? 9999));
  state.candidates = rows;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#9ca3af;padding:16px;">Kandidat nominal sama ada, tetapi tanggalnya di luar ±90 hari.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const debitTitle = isIdr ? '' : ` title="IDR ${fmt(r.debit_idr)}"`;
    const creditTitle = isIdr ? '' : ` title="IDR ${fmt(r.credit_idr)}"`;
    return `<tr>
    <td>${esc(r.journal_no)}${r.used ? '<br><span style="font-size:11px;color:#b45309;">sudah dipakai</span>' : ''}</td>
    <td>${fmtDate(r.journal_date)}</td>
    <td>${esc(r.description)}</td>
    <td>${esc(r.memo)}</td>
    <td class="num"${debitTitle}>${r.debit_cmp ? fmtMoney(r.debit_cmp, cur) : '—'}</td>
    <td class="num"${creditTitle}>${r.credit_cmp ? fmtMoney(r.credit_cmp, cur) : '—'}</td>
    <td>${r.diff === null ? '—' : (r.diff > 0 ? '+' : '') + r.diff}</td>
    <td>${r.used ? '' : `<button type="button" class="btn btn-primary" data-jlid="${r.id}" style="padding:3px 8px;font-size:11px;">Tautkan</button>`}</td>
  </tr>`;
  }).join('');
}

async function linkTo(journalLineId) {
  const line = state.candidateLine;
  if (!line) return;
  const ok = await updateLine(line.id, {
    matched_journal_line_id: Number(journalLineId),
    match_status: 'manual',
    matched_at: new Date().toISOString()
  });
  if (!ok) return;
  closeLinkModal();
  toast('Baris ditautkan manual.');
  await Promise.all([loadLines(), loadImports()]);
}

function closeLinkModal() {
  document.getElementById('linkModal').style.display = 'none';
  state.candidateLine = null;
  state.candidates = [];
}

// ============================================================
// TAB IMPORT
// ============================================================
async function handlePreview() {
  const fileInput = document.getElementById('impFile');
  const coa = document.getElementById('impCoa').value;
  const cur = normCurrency(document.getElementById('impCurrency')?.value);
  const statusEl = document.getElementById('impStatus');
  if (!coa) { toast('Pilih akun bank dulu.', true); return; }
  const file = fileInput.files && fileInput.files[0];
  if (!file) { toast('Pilih file CSV dulu.', true); return; }

  // Satu akun hanya boleh punya satu mata uang (view/recon membandingkan
  // nominal dalam mata uang rekening). Ganti mata uang = hapus import lama.
  const prevImport = state.imports.find(r => r.coa_code === coa);
  if (prevImport && normCurrency(prevImport.currency_code) !== cur) {
    toast(`Akun ${coa} sudah pernah diimpor dengan mata uang ${normCurrency(prevImport.currency_code)}. ` +
      'Hapus import lama dulu bila ingin mengganti mata uang.', true);
    return;
  }

  statusEl.textContent = 'Membaca file...';
  try {
    const text = await file.text();
    const parsed = parseBankStatementCsv(text);
    const summary = summarizeStatement(parsed.lines);
    if (!summary.nMutasi) throw new Error('File tidak berisi baris MUTASI (hanya saldo awal).');

    state.preview = {
      file_name: file.name,
      coa_code: coa,
      currency_code: cur,
      lines: parsed.lines,
      summary,
      warnings: parsed.warnings || []
    };
    renderPreview();
    statusEl.textContent =
      `Siap diimpor: ${summary.rows} baris (${summary.nOpen} saldo awal, ${summary.nMutasi} mutasi) — mata uang ${cur}.`;
  } catch (e) {
    state.preview = null;
    document.getElementById('previewCard').style.display = 'none';
    statusEl.textContent = 'Gagal membaca file.';
    toast('Gagal membaca CSV: ' + e.message, true);
  }
}

function renderPreview() {
  const p = state.preview;
  if (!p) return;
  const s = p.summary;
  const cur = normCurrency(p.currency_code);
  document.getElementById('previewCard').style.display = 'block';
  document.getElementById('previewFile').textContent = p.file_name;
  document.getElementById('previewCurrency').textContent = `· ${cur}`;
  document.getElementById('pvRows').textContent = `${s.rows} (${s.nOpen} awal / ${s.nMutasi} mutasi)`;
  document.getElementById('pvOpening').textContent = fmtMoney(s.opening, cur);
  document.getElementById('pvMasuk').textContent = fmtMoney(s.totalMasuk, cur);
  document.getElementById('pvKeluar').textContent = fmtMoney(s.totalKeluar, cur);
  document.getElementById('pvClosing').textContent = fmtMoney(s.closing, cur);
  document.getElementById('pvChain').textContent = s.breaks ? `${s.breaks} selisih` : 'OK';
  document.getElementById('pvChain').style.color = s.breaks ? '#dc2626' : '#065f46';

  const warnEl = document.getElementById('pvWarnings');
  if (p.warnings.length) {
    warnEl.style.display = 'block';
    warnEl.innerHTML = `<b>${p.warnings.length} catatan parser:</b><br>` +
      p.warnings.slice(0, 8).map(esc).join('<br>') +
      (p.warnings.length > 8 ? `<br>… dan ${p.warnings.length - 8} lainnya` : '');
  } else {
    warnEl.style.display = 'none';
    warnEl.innerHTML = '';
  }

  const shown = p.lines.slice(0, 50);
  document.getElementById('tbody-preview').innerHTML = shown.map(l => `<tr>
    <td>${l.line_no}</td>
    <td>${fmtDate(l.line_date)}</td>
    <td>${esc(l.description || '')}</td>
    <td>${l.entry_type === 'opening' ? 'Saldo awal' : 'Mutasi'}</td>
    <td class="num">${l.debit ? fmtMoney(l.debit, cur) : '—'}</td>
    <td class="num">${l.credit ? fmtMoney(l.credit, cur) : '—'}</td>
    <td class="num">${fmtMoney(l.balance, cur)}</td>
  </tr>`).join('');
  document.getElementById('pvMore').textContent = p.lines.length > 50
    ? `Menampilkan 50 dari ${p.lines.length} baris.`
    : `Menampilkan semua ${p.lines.length} baris.`;
}

async function handleCommit() {
  const p = state.preview;
  if (!p) return;
  // Pratinjau harus cocok dengan pilihan form saat ini (akun & mata uang).
  const coaNow = document.getElementById('impCoa').value;
  const curNow = normCurrency(document.getElementById('impCurrency')?.value);
  if (coaNow !== p.coa_code || curNow !== normCurrency(p.currency_code)) {
    toast('Akun atau mata uang berubah sejak pratinjau. Klik "Pratinjau" lagi.', true);
    return;
  }
  const btn = document.getElementById('commitBtn');
  btn.disabled = true;
  btn.textContent = 'Mengimpor...';

  try {
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData?.user?.id || null;
    const s = p.summary;

    const { data: imp, error: impErr } = await supabase
      .from('bank_statement_imports')
      .insert({
        coa_code: p.coa_code,
        currency_code: normCurrency(p.currency_code),
        bank_account_id: null,
        file_name: p.file_name,
        period_start: s.periodStart,
        period_end: s.periodEnd,
        opening_balance: s.opening,
        closing_balance: s.closing,
        line_count: s.rows,
        status: 'imported',
        note: `Upload UI ${new Date().toISOString().slice(0, 10)}`,
        imported_by: userId
      })
      .select('id')
      .single();
    if (impErr) {
      if (impErr.code === '23505') {
        throw new Error(`File "${p.file_name}" untuk akun ${p.coa_code} sudah pernah diimpor. Hapus dulu file lama di tab Ringkasan.`);
      }
      throw impErr;
    }

    const payload = p.lines.map(l => ({
      import_id: imp.id,
      coa_code: p.coa_code,
      line_no: l.line_no,
      line_date: l.line_date,
      period_month: l.period_month,
      entry_type: l.entry_type,
      description: l.description,
      debit: l.debit,
      credit: l.credit,
      balance: l.balance,
      ref_no: l.ref || null
    }));

    for (let i = 0; i < payload.length; i += 500) {
      const chunk = payload.slice(i, i + 500);
      const { error } = await supabase.from('bank_statement_lines').insert(chunk);
      if (error) throw new Error(`Gagal menyimpan baris ${i + 1}-${i + chunk.length}: ${error.message}`);
    }

    toast(`Berhasil mengimpor ${payload.length} baris dari ${p.file_name} (${normCurrency(p.currency_code)}).`);
    state.preview = null;
    document.getElementById('previewCard').style.display = 'none';
    document.getElementById('impFile').value = '';
    document.getElementById('impStatus').textContent = '';
    state.page = 1;
    state.filters.import_id = '';
    await loadImports();
  } catch (e) {
    toast(e.message || String(e), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Impor ke Database';
  }
}

// ============================================================
// AKSI FILE IMPORT
// ============================================================
async function deleteImport(importId) {
  const row = state.imports.find(r => String(r.import_id) === String(importId));
  const label = row ? row.file_name : `#${importId}`;
  if (!confirm(`Hapus file "${label}" beserta semua barisnya? Tindakan ini tidak bisa dibatalkan.`)) return;
  const { error } = await supabase
    .from('bank_statement_imports')
    .delete()
    .eq('id', Number(importId));
  if (error) { toast('Gagal menghapus: ' + error.message, true); return; }
  toast('File dihapus.');
  if (String(state.filters.import_id) === String(importId)) {
    state.filters.import_id = '';
    const sel = document.getElementById('fImport');
    if (sel) sel.value = '';
  }
  await loadImports();
  await loadLines();
}

async function markReconciled(importId) {
  if (!confirm('Tandai file ini sebagai RECONCILED (rekonsiliasi ditutup)?')) return;
  const { error } = await supabase
    .from('bank_statement_imports')
    .update({ status: 'reconciled' })
    .eq('id', Number(importId));
  if (error) { toast('Gagal mengubah status: ' + error.message, true); return; }
  toast('Status file: reconciled.');
  await loadImports();
}

function viewImportLines(importId) {
  state.filters.import_id = String(importId);
  state.page = 1;
  document.getElementById('fImport').value = String(importId);
  switchTab('baris');
}

// ============================================================
// TAB & EVENT
// ============================================================
function switchTab(tab) {
  if (tab === 'import' && !state.canImport) return;
  state.activeTab = tab;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => { p.style.display = 'none'; });
  const panel = document.getElementById('tab-' + tab);
  if (panel) panel.style.display = 'block';

  if (tab === 'ringkasan') loadImports();
  else if (tab === 'baris') loadLines();
  else if (tab === 'import' && !document.getElementById('impCoa').dataset.loaded) loadBankAccounts();
}

function bindEvents() {
  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('reloadImportsBtn').addEventListener('click', loadImports);
  document.getElementById('reloadLinesBtn').addEventListener('click', () => { state.page = 1; loadLines(); });

  document.getElementById('fImport').addEventListener('change', e => {
    state.filters.import_id = e.target.value;
    state.page = 1;
    loadLines();
  });
  document.getElementById('fStatus').addEventListener('change', e => {
    state.filters.status = e.target.value;
    state.page = 1;
    loadLines();
  });
  let searchTimer = null;
  document.getElementById('fSearch').addEventListener('input', e => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => {
      state.filters.search = v;
      state.page = 1;
      loadLines();
    }, 350);
  });
  document.getElementById('fFrom').addEventListener('change', e => {
    state.filters.from = e.target.value;
    state.page = 1;
    loadLines();
  });
  document.getElementById('fTo').addEventListener('change', e => {
    state.filters.to = e.target.value;
    state.page = 1;
    loadLines();
  });
  document.getElementById('fResetBtn').addEventListener('click', () => {
    state.filters = { import_id: '', status: '', search: '', from: '', to: '' };
    state.page = 1;
    document.getElementById('fImport').value = '';
    document.getElementById('fStatus').value = '';
    document.getElementById('fSearch').value = '';
    document.getElementById('fFrom').value = '';
    document.getElementById('fTo').value = '';
    loadLines();
  });

  document.getElementById('prevPageBtn').addEventListener('click', () => {
    if (state.page > 1) { state.page--; loadLines(); }
  });
  document.getElementById('nextPageBtn').addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(state.lineTotal / PAGE_SIZE));
    if (state.page < totalPages) { state.page++; loadLines(); }
  });

  document.getElementById('autoMatchBtn').addEventListener('click', () => {
    autoMatch(state.filters.import_id || null);
  });

  document.getElementById('tbody-imports').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    if (act === 'view') viewImportLines(id);
    else if (act === 'auto') autoMatch(id);
    else if (act === 'reconcile') markReconciled(id);
    else if (act === 'delete') deleteImport(id);
  });

  document.getElementById('tbody-lines').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    if (act === 'link') openLinkModal(id);
    else if (act === 'unlink') unlinkLine(id);
    else if (act === 'ignore') ignoreLine(id, true);
    else if (act === 'unignore') ignoreLine(id, false);
  });

  document.getElementById('impCoa').addEventListener('change', e => suggestCurrencyForAccount(e.target.value));

  document.getElementById('previewBtn').addEventListener('click', handlePreview);
  document.getElementById('commitBtn').addEventListener('click', handleCommit);
  document.getElementById('cancelPreviewBtn').addEventListener('click', () => {
    state.preview = null;
    document.getElementById('previewCard').style.display = 'none';
    document.getElementById('impStatus').textContent = '';
  });

  document.getElementById('linkCloseBtn').addEventListener('click', closeLinkModal);
  document.getElementById('linkModal').addEventListener('click', e => {
    if (e.target.id === 'linkModal') closeLinkModal();
  });
  document.getElementById('tbody-candidates').addEventListener('click', e => {
    const btn = e.target.closest('button[data-jlid]');
    if (btn) linkTo(btn.dataset.jlid);
  });
}

// ============================================================
// INIT
// ============================================================
(async () => {
  const user = await requireAuth();
  if (!user) return;

  const role = await requirePageAccess('rekonsiliasi-bank');
  if (!role) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('roleBadge').textContent = `(${role})`;

  await preloadPermissions();
  await renderNav(document.getElementById('mainNav'), 'rekonsiliasi-bank');

  state.canView = await hasPermission('finance.bank.view');
  state.canImport = await hasPermission('finance.bank.import');
  state.canRecon = await hasPermission('finance.bank.recon');

  if (!state.canView) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#dc2626;">Anda tidak punya akses ke halaman ini.</div>';
    return;
  }

  const importTabBtn = document.querySelector('.tabs button[data-tab="import"]');
  if (!state.canImport) importTabBtn.style.display = 'none';
  if (!state.canRecon) document.getElementById('autoMatchBtn').style.display = 'none';

  bindEvents();
  await loadImports();
  await loadLines();
})();
