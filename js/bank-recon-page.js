// js/bank-recon-page.js
// Halaman Rekonsiliasi Bank: upload CSV rekening koran, pratinjau, import ke
// bank_statement_imports / bank_statement_lines, cocokkan otomatis (RPC),
// tautkan manual / lepas / abaikan baris, ubah status file.
import { supabase } from './supabase-client.js';
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission, preloadPermissions } from './permissions.js';
import { parseBankStatementCsv, summarizeStatement } from './bank-recon-csv.js';
import { createJournal } from './journals.js';
import { listAccounts } from './accounts.js';
import { listPartners } from './partners.js';
import { getValasBookRate, getValasBookRateAcrossAccounts } from './bank-accounts.js';

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
  canJournal: false,
  canJournalEdit: false,
  imports: [],
  lines: [],
  lineTotal: 0,
  page: 1,
  filters: { import_id: '', status: '', search: '', from: '', to: '' },
  preview: null,
  candidateLine: null,
  candidates: [],
  // v11.12 — buat jurnal dari baris koran
  genLine: null,
  genBankAcc: null,
  genRateTouched: false,
  genRateReq: 0,
  genCur: 'IDR',
  accounts: null,
  partners: null
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
          if (state.canJournal) {
            acts.push(`<button type="button" class="btn btn-primary" data-act="gen" data-id="${l.id}" title="Buat jurnal baru dari baris koran ini (mis. pembayaran bunga pinjaman → Beban Bunga), lalu tautkan otomatis" style="padding:3px 8px;font-size:11px;">Buat Jurnal</button>`);
          }
        }
        if (l.match_status === 'auto' || l.match_status === 'manual') {
          acts.push(`<button type="button" class="btn btn-secondary" data-act="unlink" data-id="${l.id}" style="padding:3px 8px;font-size:11px;">Lepas</button>`);
          if (state.canJournalEdit && l.journal_id) {
            acts.push(`<a class="btn btn-secondary" href="./journal.html?id=${l.journal_id}" title="Buka jurnal ${esc(l.journal_no || '')} di halaman Jurnal untuk diperbaiki (ganti akun, reversal, dll)" style="padding:3px 8px;font-size:11px;text-decoration:none;display:inline-block;">Edit Jurnal</a>`);
          }
        }
        if (l.match_status === 'ignored') {
          acts.push(`<button type="button" class="btn btn-secondary" data-act="unignore" data-id="${l.id}" title="Batalkan abaikan — baris kembali ke Belum cocok" style="padding:3px 8px;font-size:11px;">Batal</button>`);
        } else if (l.match_status === 'unmatched') {
          acts.push(`<button type="button" class="btn btn-secondary" data-act="ignore" data-id="${l.id}" title="Abaikan baris ini (bisa dibatalkan dengan tombol Batal)" style="padding:3px 8px;font-size:11px;">Abaikan</button>`);
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
        <td><div class="row-actions">${acts.join('')}</div></td>
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
  if (!state.canRecon) { toast('Tidak ada akses rekonsiliasi bank', true); return; }
  const ok = await updateLine(id, {
    matched_journal_line_id: null,
    match_status: ignore ? 'ignored' : 'unmatched',
    matched_at: null
  });
  if (!ok) return;
  toast(ignore
    ? 'Baris diabaikan. Klik tombol "Batal" pada baris itu untuk membatalkan.'
    : 'Baris dikembalikan ke belum cocok.');
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

// Jalan pintas "buat jurnal" di dalam modal Tautkan / pesan kosong (v11.12).
function genShortcutHtml(lineId, label = 'Buat jurnal dari baris ini') {
  return `<br><button type="button" class="btn btn-primary" data-gen="${esc(lineId)}"` +
    ` style="margin-top:8px;padding:4px 10px;font-size:12px;">${esc(label)}</button>`;
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
  const CAND_SELECT = 'id, journal_id, memo, debit, credit, debit_base, credit_base';
  let { data: jls, error: jlErr } = await supabase
    .from('journal_lines')
    .select(CAND_SELECT)
    .eq('account_id', acc.id)
    .eq(amountCol, amount);
  // v11.12: nominal persis tidak ada -> ulangi dengan toleransi kecil
  // (IDR ±Rp1, valas ±0,01) supaya beda pembulatan tetap bisa ditautkan.
  let near = false;
  if (!jlErr && (!jls || !jls.length)) {
    const tol = isIdr ? 1 : 0.01;
    const retry = await supabase
      .from('journal_lines')
      .select(CAND_SELECT)
      .eq('account_id', acc.id)
      .gte(amountCol, amount - tol)
      .lte(amountCol, amount + tol);
    if (!retry.error) {
      jls = retry.data || [];
      near = jls.length > 0;
    }
  }
  if (jlErr) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#dc2626;padding:16px;">${esc(jlErr.message)}</td></tr>`;
    return;
  }
  if (near) {
    document.getElementById('linkHeader').innerHTML +=
      ` · <span style="color:#b45309;">menampilkan nominal beda ≤ ${isIdr ? 'Rp 1' : '0,01 ' + esc(cur)}</span>`;
  }
  if (!jls || !jls.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#9ca3af;padding:16px;">' +
      'Tidak ada baris jurnal dengan nominal tersebut pada akun ini.' +
      genShortcutHtml(line.id, 'Buat jurnal baru dari baris ini') +
      '</td></tr>';
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
      `Nominal sama ada, tetapi mata uang jurnalnya bukan ${esc(cur)}.` +
      genShortcutHtml(line.id, 'Buat jurnal baru dari baris ini') +
      `</td></tr>`;
    return;
  }
  rows = currencyRows.filter(r => r.diff === null || Math.abs(r.diff) <= 90);
  rows.sort((a, b) => Math.abs(a.diff ?? 9999) - Math.abs(b.diff ?? 9999));
  state.candidates = rows;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#9ca3af;padding:16px;">' +
      'Kandidat nominal sama ada, tetapi tanggalnya di luar ±90 hari.' +
      genShortcutHtml(line.id, 'Buat jurnal baru dari baris ini') +
      '</td></tr>';
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
// BUAT JURNAL DARI BARIS KORAN (v11.12)
// ------------------------------------------------------------
// Kasus: transaksi bank belum pernah dijurnal (bunga pinjaman, biaya admin,
// transfer antar bank, dll). Jurnal yang dibuat 2 baris:
//   uang MASUK  bank -> Debit Bank    ... Kredit akun lawan
//   uang KELUAR bank -> Debit akun lawan ... Kredit Bank
// Setelah jurnal dibuat, baris koran langsung ditautkan (match_status manual).
// ============================================================
function genLineMoney() {
  const line = state.genLine;
  if (!line) return { amt: 0, cur: 'IDR' };
  const amt = Math.abs(Number(
    line.amount || (Number(line.masuk || 0) || Number(line.keluar || 0))
  ));
  return { amt, cur: normCurrency(state.genCur) };
}

function genAmounts() {
  const line = state.genLine;
  if (!line) return null;
  const { amt, cur } = genLineMoney();
  const rate = cur === 'IDR'
    ? 1
    : Number(document.getElementById('genRate').value || 0);
  return { line, cur, amount: amt, rate, isIn: line.arah === 'IN' };
}

// Header modal: nominal selalu mengikuti mata uang jurnal yang dipilih.
function renderGenHeader() {
  const line = state.genLine;
  if (!line) return;
  const { amt, cur } = genLineMoney();
  document.getElementById('genHeader').innerHTML =
    `Baris #${line.line_no} · ${fmtDate(line.line_date)} · ${esc(line.description || '')}<br>` +
    `${line.arah === 'IN' ? 'Uang <b>masuk</b>' : 'Uang <b>keluar</b>'} ` +
    `<b>${genMoney(amt, cur)}</b> · akun bank ${esc(line.coa_code)}` +
    (cur === 'IDR' ? '' : ` · <b>${esc(cur)}</b>`);
}

// Tampilkan / sembunyikan field kurs sesuai mata uang terpilih.
function applyGenCurrency() {
  const cur = normCurrency(state.genCur);
  document.getElementById('genRateWrap').style.display = cur === 'IDR' ? 'none' : '';
  document.getElementById('genRateCur').textContent = cur;
  return cur;
}

// v11.13 — mata uang jurnal. Default: mata uang file koran. Kalau file tercatat
// IDR tetapi akun ini punya stok valas (USD/SGD), tawarkan valas itu supaya
// kurs buku otomatis terisi (file koran lama bisa salah tercatat IDR).
async function detectGenCurrency(line) {
  const fromFile = normCurrency(line.currency_code);
  if (fromFile !== 'IDR') return { cur: fromFile, note: '' };
  for (const c of ['USD', 'SGD']) {
    try {
      const r = await getValasBookRate(line.coa_code, c, null);
      if (r && r.rate) {
        return {
          cur: c,
          note: `File koran tercatat ${fromFile}, tetapi akun ${line.coa_code} punya stok ${c} ` +
            `(saldo ${fmt(r.saldo_valas)} ${c}). Dipakai ${c} — ubah ke IDR bila transaksi ini memang rupiah.`
        };
      }
    } catch (e) { /* akun tanpa riwayat valas — lanjut */ }
  }
  return { cur: fromFile, note: '' };
}

function genMoney(n, cur) {
  return cur === 'IDR' ? fmt(n) : `${cur} ${fmt(n)}`;
}

function renderGenPreview() {
  const el = document.getElementById('genPreview');
  if (!el) return;
  const g = genAmounts();
  const bankAcc = state.genBankAcc;
  if (!g || !bankAcc) { el.innerHTML = ''; return; }

  const counterId = document.getElementById('genCounter').value;
  const counter = (state.accounts || []).find(a => String(a.id) === String(counterId));
  const bankName = `${esc(bankAcc.code)} — ${esc(bankAcc.name)}`;
  const counterName = counter
    ? `${esc(counter.code)} — ${esc(counter.name)}`
    : '<i style="color:#b45309;">belum dipilih</i>';
  const sameAsBank = counter && String(counter.id) === String(bankAcc.id);
  const baseNote = (g.cur === 'IDR' || !(g.rate > 0))
    ? ''
    : ` <span style="color:#6b7280;">(Rp ${fmt(g.amount * g.rate)})</span>`;
  const money = genMoney(g.amount, g.cur) + baseNote;

  const rows = [
    { acc: g.isIn ? bankName : counterName, debit: money, credit: '' },
    { acc: g.isIn ? counterName : bankName, debit: '', credit: money }
  ];

  el.innerHTML =
    `<div style="font-weight:600;margin-bottom:6px;">Pratinjau jurnal</div>` +
    `<table style="width:100%;border-collapse:collapse;"><thead><tr>` +
    `<th style="text-align:left;font-weight:500;color:#6b7280;padding:2px 4px;">Akun</th>` +
    `<th style="text-align:right;font-weight:500;color:#6b7280;padding:2px 4px;">Debit</th>` +
    `<th style="text-align:right;font-weight:500;color:#6b7280;padding:2px 4px;">Kredit</th>` +
    `</tr></thead><tbody>` +
    rows.map(r => `<tr>` +
      `<td style="padding:2px 4px;">${r.acc}</td>` +
      `<td style="padding:2px 4px;text-align:right;">${r.debit || '—'}</td>` +
      `<td style="padding:2px 4px;text-align:right;">${r.credit || '—'}</td>` +
      `</tr>`).join('') +
    `</tbody></table>` +
    (g.cur === 'IDR'
      ? ''
      : `<div style="margin-top:6px;color:#6b7280;">Kurs ${esc(g.cur)} ` +
        `${g.rate > 0 ? fmt(g.rate) : '—'} · kedua baris memakai mata uang &amp; kurs yang sama.</div>`) +
    (sameAsBank
      ? `<div style="margin-top:6px;color:#dc2626;">Akun lawan tidak boleh sama dengan akun bank.</div>`
      : '');
}

// v11.13 — kurs buku bertingkat:
//   (1) rata-rata kurs buku s.d. tanggal jurnal (stok valas per tanggal itu)
//   (2) kalau stok per tanggal itu 0 (jurnal GL belum sampai tanggal koran),
//       pakai kurs buku SELURUH riwayat akun + hint peringatan
//   (3) kalau akun itu belum punya stok valas sama sekali -> kurs buku
//       gabungan akun valas (sumber disebut di hint)
//   (4) kalau semua kosong -> isi manual
async function refreshGenRate() {
  const g = genAmounts();
  const hint = document.getElementById('genRateHint');
  if (!g || !hint) return;
  const rateInput = document.getElementById('genRate');
  if (g.cur === 'IDR') { hint.textContent = ''; return; }
  if (state.genRateTouched) return;

  const token = ++state.genRateReq;
  const code = g.line.coa_code;
  const asOf = document.getElementById('genDate').value || g.line.line_date;
  hint.style.color = '#6b7280';
  hint.textContent = 'Menghitung kurs buku…';

  try {
    let mode = 'asof';
    let r = await getValasBookRate(code, g.cur, asOf);
    if (token !== state.genRateReq) return;
    if (!r || !r.rate) {
      mode = 'histori';
      r = await getValasBookRate(code, g.cur, null);
      if (token !== state.genRateReq) return;
    }

    // v11.13 — akun ini belum punya stok valas sama sekali:
    // pakai kurs buku rata-rata gabungan akun valas (sumber disebut di hint).
    let combo = null;
    if (!r || !r.rate) {
      mode = 'gabungan';
      combo = await getValasBookRateAcrossAccounts(g.cur, asOf);
      if (token !== state.genRateReq) return;
      if (!combo || !combo.rate) {
        combo = await getValasBookRateAcrossAccounts(g.cur, null);
        if (token !== state.genRateReq) return;
        mode = 'gabungan-historis';
      }
      if (combo && combo.rate) {
        r = { rate: combo.rate, saldo_valas: combo.saldo_valas, saldo_idr: combo.saldo_idr };
      }
    }

    if (r && r.rate) {
      rateInput.value = String(Math.round(r.rate * 10000) / 10000);
      const saldo = `saldo ${esc(g.cur)} ${fmt(r.saldo_valas)} = Rp ${fmt(r.saldo_idr)}`;
      const sumber = combo && combo.accounts && combo.accounts.length
        ? combo.accounts.slice(0, 3).map(x => esc(x.code)).join(', ')
        : '';
      if (mode === 'asof') {
        hint.innerHTML = `Kurs buku rata-rata <b>${esc(code)}</b> s.d. ${fmtDate(asOf)}: ` +
          `<b>${fmt(r.rate)}</b> — ${saldo}. Boleh diubah.`;
      } else if (mode === 'histori') {
        hint.innerHTML = `Stok ${esc(g.cur)} <b>${esc(code)}</b> per ${fmtDate(asOf)} masih 0 — ` +
          `dipakai kurs buku seluruh riwayat akun: <b>${fmt(r.rate)}</b> (${saldo}). Boleh diubah.`;
      } else {
        hint.innerHTML = `Akun <b>${esc(code)}</b> belum punya stok ${esc(g.cur)} — ` +
          `dipakai kurs buku rata-rata ${esc(g.cur)} gabungan akun valas` +
          (sumber ? ` (${sumber})` : '') +
          `${mode === 'gabungan-historis' ? ' seluruh riwayat' : ` s.d. ${fmtDate(asOf)}`}: ` +
          `<b>${fmt(r.rate)}</b> (${saldo}). Boleh diubah.`;
      }
      if (mode !== 'asof' || Number(r.saldo_valas) < 0) hint.style.color = '#92400e';
    } else {
      rateInput.value = '';
      hint.style.color = '#b45309';
      hint.textContent =
        `Belum ada stok ${g.cur} di akun ${code} maupun di akun valas lain — isi kurs manual, ` +
        `atau ubah "Mata uang" di atas bila transaksi ini bukan ${g.cur}.`;
    }
  } catch (e) {
    if (token !== state.genRateReq) return;
    hint.style.color = '#dc2626';
    hint.textContent = 'Gagal menghitung kurs buku: ' + (e.message || e) + ' — isi kurs manual.';
  }
  renderGenPreview();
}

async function ensureGenLists() {
  const cSel = document.getElementById('genCounter');
  if (!state.accounts) state.accounts = await listAccounts();
  if (!cSel.dataset.loaded) {
    cSel.innerHTML = '<option value="">— pilih akun lawan —</option>' +
      state.accounts.map(a => `<option value="${a.id}">${esc(a.code)} — ${esc(a.name)}</option>`).join('');
    cSel.dataset.loaded = '1';
  }

  const pSel = document.getElementById('genPartner');
  if (!state.partners) {
    try { state.partners = await listPartners(); } catch (e) { state.partners = []; }
  }
  if (!pSel.dataset.loaded) {
    pSel.innerHTML = '<option value="">— tanpa partner —</option>' +
      state.partners.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    pSel.dataset.loaded = '1';
  }
}

async function openGenModal(lineId) {
  const line = state.lines.find(l => String(l.id) === String(lineId));
  if (!line) return;
  if (!state.canRecon) { toast('Tidak ada akses rekonsiliasi bank', true); return; }
  if (!state.canJournal) {
    toast('Tidak ada akses membuat jurnal (finance.journal.create)', true);
    return;
  }
  if (line.match_status === 'auto' || line.match_status === 'manual') {
    toast('Baris ini sudah tertaut ke jurnal. Klik "Lepas" dulu bila ingin membuat jurnal baru.', true);
    return;
  }

  state.genLine = line;
  state.genBankAcc = null;
  state.genRateTouched = false;
  state.genCur = normCurrency(line.currency_code);

  const hari = String(line.line_date || '').slice(0, 10);
  document.getElementById('genDate').value = hari;
  document.getElementById('genDesc').value = line.description || '';
  document.getElementById('genMemo').value = '';
  document.getElementById('genCounter').value = '';
  document.getElementById('genPartner').value = '';
  document.getElementById('genCurrency').value = state.genCur;
  document.getElementById('genCurHint').textContent =
    `Mata uang file koran: ${state.genCur}. Ganti bila rekening ini valas.`;
  applyGenCurrency();
  document.getElementById('genRate').value = '';
  document.getElementById('genRateHint').textContent = state.genCur === 'IDR' ? '' : 'Menghitung kurs buku…';
  document.getElementById('genPreview').innerHTML = '';
  renderGenHeader();
  document.getElementById('genModal').style.display = 'flex';

  const { data: bankAcc, error: baErr } = await supabase
    .from('accounts').select('id, code, name').eq('code', line.coa_code).maybeSingle();
  if (baErr || !bankAcc) {
    toast('Akun bank ' + line.coa_code + ' tidak ditemukan di COA.', true);
    closeGenModal();
    return;
  }
  state.genBankAcc = bankAcc;

  try {
    await ensureGenLists();
  } catch (e) {
    toast('Gagal memuat daftar akun/partner: ' + (e.message || e), true);
  }

  // v11.13 — deteksi mata uang: kalau file koran tercatat IDR tetapi akun ini
  // punya stok valas, otomatis pakai valas itu supaya kurs buku terisi.
  const det = await detectGenCurrency(line);
  if (det.cur !== state.genCur) {
    state.genCur = det.cur;
    document.getElementById('genCurrency').value = det.cur;
    applyGenCurrency();
    renderGenHeader();
  }
  document.getElementById('genCurHint').textContent = det.note
    || `Mata uang file koran: ${normCurrency(line.currency_code)}. Ganti bila rekening ini valas.`;

  await refreshGenRate();
  renderGenPreview();
}

function closeGenModal() {
  const modal = document.getElementById('genModal');
  if (modal) modal.style.display = 'none';
  state.genLine = null;
  state.genBankAcc = null;
  state.genRateTouched = false;
}

async function saveGen() {
  const g = genAmounts();
  const bankAcc = state.genBankAcc;
  if (!g || !bankAcc) return;

  const { line, cur, amount, rate, isIn } = g;
  const counterId = Number(document.getElementById('genCounter').value || 0);
  if (!counterId) { toast('Pilih akun lawan (COA) dulu.', true); return; }
  if (String(counterId) === String(bankAcc.id)) {
    toast('Akun lawan tidak boleh sama dengan akun bank.', true);
    return;
  }
  if (!(amount > 0)) { toast('Nominal baris 0 — tidak bisa dibuat jurnal.', true); return; }
  if (cur !== 'IDR' && !(rate > 0)) { toast(`Kurs ${cur} wajib diisi (> 0).`, true); return; }

  const journalDate = document.getElementById('genDate').value;
  if (!journalDate) { toast('Tanggal jurnal wajib diisi.', true); return; }
  const desc = document.getElementById('genDesc').value.trim()
    || line.description
    || 'Jurnal dari rekening koran';
  const memo = document.getElementById('genMemo').value.trim() || null;
  const partnerId = Number(document.getElementById('genPartner').value || 0) || null;
  const lineRate = cur === 'IDR' ? 1 : rate;

  const bankLine = {
    account_id: bankAcc.id,
    partner_id: null,
    debit: isIn ? amount : 0,
    credit: isIn ? 0 : amount,
    currency_code: cur,
    exchange_rate: lineRate,
    memo: memo || desc
  };
  const counterLine = {
    account_id: counterId,
    partner_id: partnerId,
    debit: isIn ? 0 : amount,
    credit: isIn ? amount : 0,
    currency_code: cur,
    exchange_rate: lineRate,
    memo: memo
  };

  const btn = document.getElementById('genSaveBtn');
  const oldLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  try {
    const created = await createJournal({
      journal_date: journalDate,
      description: desc,
      ref_no: `KORAN-${line.import_id}-${line.line_no}`,
      currency_code: cur,
      exchange_rate: lineRate,
      lines: [bankLine, counterLine]
    });

    // Cari baris jurnal milik akun bank untuk ditautkan ke baris koran.
    const { data: jls, error: jlErr } = await supabase
      .from('journal_lines')
      .select('id, debit, credit')
      .eq('journal_id', created.id)
      .eq('account_id', bankAcc.id);
    if (jlErr) throw jlErr;
    const target = (jls || []).find(r => Number(isIn ? r.credit : r.debit) > 0) || (jls || [])[0];
    if (!target) {
      toast(`Jurnal ${created.journal_no} terbuat, tetapi baris bank tidak ditemukan. Tautkan manual.`, true);
    } else {
      const ok = await updateLine(line.id, {
        matched_journal_line_id: target.id,
        match_status: 'manual',
        matched_at: new Date().toISOString()
      });
      if (ok) {
        toast(`Jurnal ${created.journal_no} dibuat & ditautkan ke baris #${line.line_no}.`);
      } else {
        toast(`Jurnal ${created.journal_no} terbuat, tetapi penautan gagal. Buka tab Baris lalu Tautkan.`, true);
      }
    }
    closeGenModal();
    await Promise.all([loadLines(), loadImports()]);
  } catch (e) {
    toast(e.message || String(e), true);
  } finally {
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
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
    else if (act === 'gen') openGenModal(id);
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
    const linkBtn = e.target.closest('button[data-jlid]');
    if (linkBtn) { linkTo(linkBtn.dataset.jlid); return; }
    // Jalan pintas: tidak ada kandidat -> buat jurnal baru dari baris ini.
    const genBtn = e.target.closest('button[data-gen]');
    if (genBtn) {
      const id = genBtn.dataset.gen;
      closeLinkModal();
      openGenModal(id);
    }
  });

  // Modal buat jurnal (v11.12)
  document.getElementById('genCloseBtn').addEventListener('click', closeGenModal);
  document.getElementById('genCancelBtn').addEventListener('click', closeGenModal);
  document.getElementById('genModal').addEventListener('click', e => {
    if (e.target.id === 'genModal') closeGenModal();
  });
  document.getElementById('genSaveBtn').addEventListener('click', saveGen);
  document.getElementById('genCounter').addEventListener('change', renderGenPreview);
  document.getElementById('genPartner').addEventListener('change', renderGenPreview);
  document.getElementById('genDate').addEventListener('change', () => {
    if (!state.genRateTouched) refreshGenRate();
  });
  document.getElementById('genRate').addEventListener('input', () => {
    state.genRateTouched = true;
    renderGenPreview();
  });
  // v11.13 — ganti mata uang jurnal (mis. file koran tercatat IDR padahal valas)
  document.getElementById('genCurrency').addEventListener('change', e => {
    state.genCur = normCurrency(e.target.value);
    state.genRateTouched = false;
    document.getElementById('genRate').value = '';
    applyGenCurrency();
    renderGenHeader();
    renderGenPreview();
    refreshGenRate();
  });
  // Hitung ulang kurs buku (mis. setelah ubah manual)
  document.getElementById('genRateResetBtn').addEventListener('click', () => {
    state.genRateTouched = false;
    document.getElementById('genRate').value = '';
    refreshGenRate();
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
  state.canJournal = await hasPermission('finance.journal.create');
  state.canJournalEdit = await hasPermission('finance.journal.edit');

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
