// js/reports-page.js
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess, canAccess } from './access.js';
import { hasPermission } from './permissions.js';
import {
  trialBalance, cashflow, agingPiutang, agingHutang,
  salesReport, labaRugi, neraca,
  ledgerAccountList, ledgerByAccount
} from './reports.js?v=11.51';
// v11.34 — hapus cepat jurnal dari Buku Besar (khusus superadmin).
// Fungsi data layer ini sama dengan yang dipakai halaman Jurnal
// (RPC delete_journal_with_lock, guard periode di server).
import { deleteJournal } from './journals.js';

// ============================================================
// STATE
// ============================================================
const state = {
  from: null,
  to: null,
  activeTab: 'tb',
  lastData: null,
  perms: {},
  role: null,
  // focusLine = line_id yang disorot saat kembali dari halaman Jurnal
  bb: { code: null, list: null, data: null, focusLine: null }
};

// ============================================================
// UTIL
// ============================================================
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => el.className = 'toast', 2500);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function fmt(n) {
  const v = Number(n || 0);
  return v.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function fmtInt(n) {
  return Number(n || 0).toLocaleString('id-ID');
}
// Nominal valas selalu 2 desimal (USD punya sen)
function fmtValas(n) {
  return Number(n || 0).toLocaleString('id-ID', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
}
// YYYY-MM-DD -> dd/mm/yyyy
function tgl(s) {
  if (!s) return '';
  const p = String(s).slice(0, 10).split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : String(s);
}
function periodLabel(from, to) {
  if (!from && !to) return 'Semua periode';
  return `${from || '...'} s/d ${to || '...'}`;
}

// ============================================================
// INIT
// ============================================================
(async () => {
  const user = await requireAuth();
  if (!user) return;

  const role = await requirePageAccess('reports');
  if (!role) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  await renderNav(document.getElementById('mainNav'), 'reports');

  // Muat permission
  state.perms.export           = await hasPermission('reports.export');
  state.perms.periodSet        = await hasPermission('reports.period.set');
  state.perms.trialBalance     = await hasPermission('reports.trial_balance');
  state.perms.cashflow         = await hasPermission('reports.cashflow');
  state.perms.aging            = await hasPermission('reports.aging_piutang');
  state.perms.agingHutang      = await hasPermission('finance.hutang.detail');
  state.perms.salesPerformance = await hasPermission('reports.view');
  state.perms.labaRugi         = await hasPermission('reports.laba_rugi');
  state.perms.neraca           = await hasPermission('reports.neraca');

  // v11.34 — aksi jurnal dari Buku Besar.
  // Edit/Reversal/Hapus tetap dikerjakan di journal.html (satu tempat, sudah
  // teruji: cek periode, double confirm, RPC). Di sini hanya butuh tahu
  // apakah kolom "Aksi" perlu ditampilkan.
  state.perms.journalEdit     = await hasPermission('finance.journal.edit');
  state.perms.journalReversal = await hasPermission('finance.journal.reversal');
  state.perms.journalDelete   = await hasPermission('finance.journal.delete');
  // Hapus permanen langsung dari Buku Besar HANYA superadmin.
  // Admin biasa tetap bisa menghapus lewat halaman Jurnal (izin yang sama).
  state.perms.quickDelete = role === 'superadmin' && state.perms.journalDelete;
  // Tombol "Kelola" mengarah ke journal.html -> hanya berguna kalau role ini
  // memang punya akses halaman Jurnal (page_access). Contoh: supervisor punya
  // finance.journal.reversal tetapi TIDAK punya akses halaman journal, jadi
  // kolom Aksi tidak ditampilkan untuknya.
  state.perms.canJournalPage = await canAccess('journal', role);
  state.role = role;

  if (!state.perms.export) {
    document.getElementById('exportCsv').style.display = 'none';
    document.getElementById('printReportBtn').style.display = 'none';
  }
  if (!state.perms.periodSet) {
    document.getElementById('applyFilter').disabled = true;
    document.getElementById('resetFilter').disabled = true;
  }

  // Sembunyikan tab yang tidak berhak
  // Buku Besar memakai izin yang sama dengan Trial Balance (tidak ada
  // permission key baru, jadi tidak perlu migrasi SQL).
  const tabPerms = {
    tb: state.perms.trialBalance,
    cf: state.perms.cashflow,
    ar: state.perms.aging,
    ap: state.perms.agingHutang,
    sp: state.perms.salesPerformance,
    lr: state.perms.labaRugi,
    nc: state.perms.neraca,
    bb: state.perms.trialBalance
  };
  let firstAllowed = null;
  Object.entries(tabPerms).forEach(([tab, ok]) => {
    const btn = document.querySelector(`.tabs button[data-tab="${tab}"]`);
    if (!ok && btn) btn.style.display = 'none';
    else if (ok && !firstAllowed) firstAllowed = tab;
  });

  // Default periode
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  document.getElementById('filterFrom').value = firstOfMonth.toISOString().slice(0, 10);
  document.getElementById('filterTo').value = today.toISOString().slice(0, 10);
  state.from = document.getElementById('filterFrom').value;
  state.to = document.getElementById('filterTo').value;

  // Buka tab / akun tertentu dari URL
  // contoh (dari Dashboard): reports.html?tab=bb&akun=1-1120
  const urlParams = new URLSearchParams(location.search);
  const wantTab  = urlParams.get('tab');
  const wantAkun = urlParams.get('akun');
  const wantFrom = urlParams.get('from');
  const wantTo   = urlParams.get('to');
  // line = line_id jurnal yang terakhir dibuka (dari tombol Kelola) supaya
  // saat kembali baris tersebut bisa disorot & di-scroll.
  const wantLine = Number(urlParams.get('line') || 0);
  if (wantFrom) {
    document.getElementById('filterFrom').value = wantFrom;
    state.from = wantFrom;
  }
  if (wantTo) {
    document.getElementById('filterTo').value = wantTo;
    state.to = wantTo;
  }
  if (wantTab && tabPerms[wantTab]) firstAllowed = wantTab;
  state.bb.code = wantAkun || null;
  state.bb.focusLine = wantLine > 0 ? wantLine : null;

  // Aktifkan tab pertama yang berhak
  if (firstAllowed) {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
    document.querySelector(`.tabs button[data-tab="${firstAllowed}"]`).classList.add('active');
    document.getElementById('tab-' + firstAllowed).style.display = 'block';
    state.activeTab = firstAllowed;
  }

  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTab = btn.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      document.getElementById('tab-' + state.activeTab).style.display = 'block';
      loadActive();
    });
  });

  document.getElementById('applyFilter').addEventListener('click', () => {
    state.from = document.getElementById('filterFrom').value || null;
    state.to   = document.getElementById('filterTo').value || null;
    loadActive();
  });
  document.getElementById('resetFilter').addEventListener('click', () => {
    document.getElementById('filterFrom').value = '';
    document.getElementById('filterTo').value = '';
    state.from = null;
    state.to = null;
    loadActive();
  });
    // ===== YTD / MTD =====
  const pad = n => String(n).padStart(2, '0');
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  document.getElementById('btnYtd').addEventListener('click', () => {
    const d = new Date();
    const from = `${d.getFullYear()}-01-01`;
    const to = todayStr();
    document.getElementById('filterFrom').value = from;
    document.getElementById('filterTo').value = to;
    state.from = from;
    state.to = to;
    loadActive();
  });

  document.getElementById('btnMtd').addEventListener('click', () => {
    const d = new Date();
    const from = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
    const to = todayStr();
    document.getElementById('filterFrom').value = from;
    document.getElementById('filterTo').value = to;
    state.from = from;
    state.to = to;
    loadActive();
  });
  document.getElementById('exportCsv').addEventListener('click', exportCsv);
  document.getElementById('printReportBtn').addEventListener('click', printReport);

  // ===== BUKU BESAR =====
  document.getElementById('bbAccount').addEventListener('change', e => {
    state.bb.code = e.target.value || null;
    // v11.34 — sorotan baris hanya untuk baris yang tadi dibuka dari tombol
    // Kelola; ganti akun = konteks baru, jangan menyorot apa pun.
    state.bb.focusLine = null;
    if (state.bb.code) loadLedger();
    else resetLedgerPanel();
  });
  document.getElementById('bbLoad').addEventListener('click', () => {
    state.bb.code = document.getElementById('bbAccount').value || null;
    if (!state.bb.code) { toast('Pilih akun terlebih dahulu', true); return; }
    loadLedger();
  });

  await loadActive();
})();

// ============================================================
// DISPATCH
// ============================================================
async function loadActive() {
  if (state.activeTab === 'tb') await loadTrialBalance();
  else if (state.activeTab === 'cf') await loadCashflow();
  else if (state.activeTab === 'ar') await loadAging();
  else if (state.activeTab === 'ap') await loadAgingHutang();
  else if (state.activeTab === 'sp') await loadSalesReport();
  else if (state.activeTab === 'lr') await loadLabaRugi();
  else if (state.activeTab === 'nc') await loadNeraca();
  else if (state.activeTab === 'bb') await loadLedger();
}

// ============================================================
// BUKU BESAR (LEDGER) PER AKUN
// ------------------------------------------------------------
// Valuta & nominal per baris berasal dari journal_lines (currency_code,
// debit, credit); kolom rupiah memakai nilai dasar historis (_base).
// ============================================================
// Kode valuta yang muncul di NAMA akun ("Bank CIMB USD", "Piutang Dagang USD").
// CATATAN: accounts.is_fx_monetary TIDAK dipakai sebagai penanda "akun valas",
// karena SQL-v10.1 menandai semua akun moneter (termasuk bank IDR 1-1100/1-1110)
// dengan true — flag itu hanya berarti "direvaluasi di TB kurs pajak".
const CURRENCY_HINTS = ['USD', 'SGD', 'EUR', 'JPY', 'CNY', 'GBP', 'AUD'];
function accountCurrencyHint(name) {
  const nm = String(name || '').toUpperCase();
  return CURRENCY_HINTS.find(c => nm.includes(c)) || null;
}

// ============================================================
// AKSI JURNAL DARI BUKU BESAR (v11.34)
// ------------------------------------------------------------
// Edit / Reversal / Hapus TIDAK diduplikasi di halaman laporan. Tombol
// "Kelola" membuka journal.html yang sudah memuat form edit, reversal,
// hapus, guard periode, dan double confirm. Parameter yang dikirim:
//   id   = journals.id  -> kartu jurnal disorot
//   q    = journal_no   -> langsung dicari supaya kartu pasti muncul
//   back = URL laporan ini (akun + periode + line) -> tombol "← Kembali"
// ============================================================
function ledgerBackUrl(code, lineId = null) {
  const p = new URLSearchParams();
  p.set('tab', 'bb');
  if (code) p.set('akun', code);
  if (state.from) p.set('from', state.from);
  if (state.to) p.set('to', state.to);
  if (lineId) p.set('line', lineId);
  return './reports.html?' + p.toString();
}

function ledgerActionButtons(row, code) {
  const p = new URLSearchParams();
  p.set('id', row.journal_id);
  p.set('q', row.journal_no);
  p.set('back', ledgerBackUrl(code, row.line_id));

  const btns = [
    `<a class="btn btn-secondary btn-xs" href="./journal.html?${p.toString()}"`
    + ` title="Buka jurnal ${esc(row.journal_no)} di halaman Jurnal (edit, reversal, hapus)">Kelola</a>`
  ];
  // Hapus permanen langsung dari tabel: khusus superadmin, dan hanya untuk
  // jurnal biasa — jurnal REVERSAL tidak boleh dihapus (sama seperti halaman
  // Jurnal) supaya pasangan asli-reversal tetap utuh sebagai jejak audit.
  if (state.perms.quickDelete && !row.reversal_of) {
    btns.push(
      `<button type="button" class="btn btn-danger btn-xs"`
      + ` data-quick-delete="${row.journal_id}" data-no="${esc(row.journal_no)}">Hapus</button>`
    );
  }
  return `<div class="row-actions">${btns.join('')}</div>`;
}

async function onQuickDelete(journalId, journalNo) {
  if (!state.perms.quickDelete) {
    toast('Hanya superadmin yang boleh menghapus jurnal permanen', true);
    return;
  }
  if (!confirm(
    `HAPUS PERMANEN jurnal ${journalNo}?\n\n` +
    `Tindakan ini tidak bisa dibatalkan. Untuk koreksi normal, gunakan ` +
    `tombol Kelola -> Reversal di halaman Jurnal.`
  )) return;
  if (!confirm(`Konfirmasi sekali lagi: hapus permanen ${journalNo}?`)) return;

  try {
    await deleteJournal(journalId);
    toast(`✓ Jurnal ${journalNo} dihapus permanen`);
    state.bb.focusLine = null;
    await loadLedger();
  } catch (err) {
    toast('Gagal hapus: ' + (err.message || err), true);
  }
}

async function ensureLedgerAccounts() {
  if (state.bb.list) return state.bb.list;
  const list = await ledgerAccountList();
  state.bb.list = list;
  const sel = document.getElementById('bbAccount');
  sel.innerHTML = '<option value="">— pilih akun —</option>' + list.map(a => {
    const hint = accountCurrencyHint(a.name);
    return `<option value="${esc(a.code)}">${esc(a.code)} · ${esc(a.name)}`
      + `${hint ? ` (${hint})` : ''}</option>`;
  }).join('');
  return list;
}

function resetLedgerPanel() {
  document.getElementById('thead-bb').innerHTML = '';
  document.getElementById('tbody-bb').innerHTML =
    '<tr><td style="text-align:center;color:#9ca3af;">Pilih akun untuk menampilkan buku besar</td></tr>';
  document.getElementById('tfoot-bb').innerHTML = '';
  document.getElementById('bbSummary').style.display = 'none';
  document.getElementById('bbNote').textContent = '';
  state.bb.data = null;
  state.lastData = null;
}

async function loadLedger() {
  const thead   = document.getElementById('thead-bb');
  const tbody   = document.getElementById('tbody-bb');
  const tfoot   = document.getElementById('tfoot-bb');
  const summary = document.getElementById('bbSummary');
  const note    = document.getElementById('bbNote');
  document.getElementById('bbPeriod').textContent = periodLabel(state.from, state.to);

  try {
    await ensureLedgerAccounts();
    const sel = document.getElementById('bbAccount');
    if (state.bb.code) sel.value = state.bb.code;
    const code = state.bb.code || sel.value;
    if (!code) { resetLedgerPanel(); return; }

    thead.innerHTML = '';
    tbody.innerHTML = '<tr><td style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
    tfoot.innerHTML = '';
    summary.style.display = 'none';
    note.textContent = '';

    const d = await ledgerByAccount({ accountCode: code, from: state.from, to: state.to });
    state.bb.data = d;
    state.lastData = { type: 'bb', data: d };
    const cur = d.currency;
    // Kolom Valuta hanya ditampilkan kalau satu akun benar-benar memuat >1 valuta
    // (kasus normal: semua baris sevaluta -> kolom mubazir dihilangkan).
    const mixed = new Set(d.rows.map(r => r.currency)).size > 1;
    // Kolom "Aksi" hanya untuk user yang berhak mengubah jurnal DAN punya akses
    // ke halaman Jurnal (tempat tombol Kelola bermuara).
    const showActions = state.perms.canJournalPage
      && !!(state.perms.journalEdit || state.perms.journalReversal
        || state.perms.journalDelete);

    const cols = [
      { t: 'Tanggal',    cls: 'col-date' },
      { t: 'No. Jurnal', cls: '' },
      { t: 'Keterangan', cls: '' }
    ];
    if (d.is_valas) {
      if (mixed) cols.push({ t: 'Valuta', cls: 'col-cur' });
      cols.push({ t: 'Kurs', cls: 'col-rate num' });
      cols.push({ t: `Debit (${cur})`,  cls: 'num' });
      cols.push({ t: `Kredit (${cur})`, cls: 'num' });
      cols.push({ t: `Saldo (${cur})`,  cls: 'num' });
      cols.push({ t: 'Debit (Rp)',  cls: 'num' });
      cols.push({ t: 'Kredit (Rp)', cls: 'num' });
      cols.push({ t: 'Saldo (Rp)',  cls: 'num' });
    } else {
      cols.push({ t: 'Debit',  cls: 'num' });
      cols.push({ t: 'Kredit', cls: 'num' });
      cols.push({ t: 'Saldo',  cls: 'num' });
    }

    thead.innerHTML = '<tr>' + cols.map(c =>
      `<th class="${c.cls}">${esc(c.t)}</th>`).join('')
      + (showActions ? '<th class="col-act">Aksi</th>' : '') + '</tr>';

    // Ringkasan: saldo awal / mutasi periode / saldo akhir
    const saldoAwal = d.is_valas
      ? `${cur} ${fmtValas(d.opening.native)}<span style="color:#6b7280;font-weight:400;"> · Rp ${fmt(d.opening.base)}</span>`
      : `Rp ${fmt(d.opening.base)}`;
    const saldoAkhir = d.is_valas
      ? `${cur} ${fmtValas(d.totals.closing_native)}<span style="color:#6b7280;font-weight:400;"> · Rp ${fmt(d.totals.closing_base)}</span>`
      : `Rp ${fmt(d.totals.closing_base)}`;

    summary.style.display = 'block';
    summary.innerHTML = `
      <div class="filter-row" style="gap:22px;flex-wrap:wrap;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;">
        <div>
          <div style="font-size:12px;color:#6b7280;">Akun</div>
          <div style="font-weight:600;">${esc(d.account.code)} · ${esc(d.account.name)}</div>
        </div>
        <div>
          <div style="font-size:12px;color:#6b7280;">Saldo Awal</div>
          <div style="font-weight:600;">${saldoAwal}</div>
        </div>
        <div>
          <div style="font-size:12px;color:#6b7280;">Mutasi Periode (Rp)</div>
          <div style="font-weight:600;">D ${fmt(d.totals.debit)} · K ${fmt(d.totals.credit)}</div>
        </div>
        <div>
          <div style="font-size:12px;color:#6b7280;">Saldo Akhir</div>
          <div style="font-weight:600;color:${d.totals.closing_base < 0 ? '#b91c1c' : '#111827'};">${saldoAkhir}</div>
        </div>
      </div>`;

    tbody.innerHTML = d.rows.map(r => {
      const tds = [
        `<td class="col-date" data-label="Tanggal">${tgl(r.journal_date)}</td>`,
        `<td data-label="Jurnal">${esc(r.journal_no)}</td>`,
        `<td data-label="Keterangan">${esc(r.description)}</td>`
      ];
      if (d.is_valas) {
        const saldoNat = r.balance_native === null
          ? '<span style="color:#9ca3af;">—</span>'
          : fmtValas(r.balance_native);
        // Baris valuta lain (bukan valuta akun) diberi label valutanya sendiri
        const nat = v => (!v ? ''
          : (r.currency === d.currency ? fmtValas(v) : `${esc(r.currency)} ${fmt(v)}`));
        if (mixed) {
          tds.push(`<td class="col-cur" data-label="Valuta">${esc(r.currency)}</td>`);
        }
        tds.push(`<td class="col-rate num" data-label="Kurs">${r.exchange_rate ? fmt(r.exchange_rate) : '—'}</td>`);
        tds.push(`<td data-label="Debit" class="num">${nat(r.debit)}</td>`);
        tds.push(`<td data-label="Kredit" class="num">${nat(r.credit)}</td>`);
        tds.push(`<td data-label="Saldo Valuta" class="num">${saldoNat}</td>`);
        tds.push(`<td data-label="Debit Rp" class="num">${r.debit_base ? fmt(r.debit_base) : ''}</td>`);
        tds.push(`<td data-label="Kredit Rp" class="num">${r.credit_base ? fmt(r.credit_base) : ''}</td>`);
        tds.push(`<td data-label="Saldo Rp" class="num ${r.balance < 0 ? 'neg' : ''}">${fmt(r.balance)}</td>`);
      } else {
        tds.push(`<td data-label="Debit" class="num">${r.debit_base ? fmt(r.debit_base) : ''}</td>`);
        tds.push(`<td data-label="Kredit" class="num">${r.credit_base ? fmt(r.credit_base) : ''}</td>`);
        tds.push(`<td data-label="Saldo" class="num ${r.balance < 0 ? 'neg' : ''}">${fmt(r.balance)}</td>`);
      }
      if (showActions) {
        tds.push(`<td class="col-act" data-label="Aksi">${ledgerActionButtons(r, code)}</td>`);
      }
      const focusCls = r.line_id === state.bb.focusLine ? ' class="row-focus"' : '';
      return `<tr${focusCls}>${tds.join('')}</tr>`;
    }).join('') || `<tr><td colspan="${cols.length + (showActions ? 1 : 0)}" style="text-align:center;color:#9ca3af;">`
      + 'Tidak ada mutasi pada periode ini</td></tr>';

    const spanTotal = cols.length - 3;
    tfoot.innerHTML = `<tr class="report-total">
        <td colspan="${spanTotal}">TOTAL</td>
        <td class="num">${fmt(d.totals.debit)}</td>
        <td class="num">${fmt(d.totals.credit)}</td>
        <td class="num">${fmt(d.totals.closing_base)}</td>
        ${showActions ? '<td></td>' : ''}
      </tr>`;

    const definisiSaldo = ' <b>Saldo</b> tiap baris = saldo awal periode + debit − kredit'
      + ' (baris terakhir = Saldo Akhir).';
    note.innerHTML = (d.is_valas
      ? 'Nominal debit/kredit ditampilkan dalam mata uang asli tiap baris'
        + `${mixed ? ' (lihat kolom <b>Valuta</b>)' : ''}. `
        + `Saldo valuta hanya mengakumulasi baris sevaluta <b>${esc(cur)}</b>; baris valuta lain diberi tanda "—". `
        + 'Kolom Rupiah memakai nilai dasar historis (kurs saat jurnal), bukan kurs ulang.'
      : 'Seluruh nominal dalam Rupiah (nilai dasar historis saat jurnal dibuat).')
      + definisiSaldo;
    if (showActions) {
      note.innerHTML += '<br>Kolom <b>Aksi</b>: tombol <b>Kelola</b> membuka jurnal di halaman '
        + 'Jurnal (edit / reversal / hapus) — setelah selesai klik <b>← Kembali</b> untuk '
        + 'kembali ke akun &amp; periode ini.'
        + (state.perms.quickDelete
          ? ' Tombol <b>Hapus</b> = hapus permanen (khusus superadmin).'
          : '');
    }

    // Hapus cepat (superadmin) — listener dipasang ulang setiap render.
    tbody.querySelectorAll('[data-quick-delete]').forEach(btn => {
      btn.addEventListener('click', () =>
        onQuickDelete(Number(btn.dataset.quickDelete), btn.dataset.no));
    });

    // Kembali dari halaman Jurnal: sorot + scroll ke baris yang tadi dibuka.
    const focusRow = tbody.querySelector('tr.row-focus');
    if (focusRow) {
      setTimeout(() => focusRow.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
    }
  } catch (err) {
    thead.innerHTML = '';
    tbody.innerHTML = `<tr><td style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
    tfoot.innerHTML = '';
    summary.style.display = 'none';
  }
}

// ============================================================
// TRIAL BALANCE
// ============================================================
async function loadTrialBalance() {
  const tbody = document.getElementById('tbody-tb');
  const tfoot = document.getElementById('tfoot-tb');
  document.getElementById('tbPeriod').textContent = periodLabel(state.from, state.to);
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  try {
    const rows = await trialBalance({ from: state.from, to: state.to });
    let sumD = 0, sumC = 0;
    tbody.innerHTML = rows.map(r => {
      sumD += Number(r.total_debit);
      sumC += Number(r.total_credit);
      const badge = `<span class="badge-type badge-${r.type}">${r.type}</span>`;
      const balCls = r.balance < 0 ? 'neg' : (r.balance > 0 ? 'pos' : '');
      return `
        <tr>
          <td data-label="Kode">${esc(r.code)}</td>
          <td data-label="Nama">${esc(r.name)}</td>
          <td data-label="Tipe">${badge}</td>
          <td data-label="Debit" class="num">${fmt(r.total_debit)}</td>
          <td data-label="Kredit" class="num">${fmt(r.total_credit)}</td>
          <td data-label="Saldo" class="num ${balCls}">${fmt(r.balance)}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="6" style="text-align:center;color:#9ca3af;">Tidak ada data</td></tr>';

    tfoot.innerHTML = `
      <tr class="report-total">
        <td colspan="3">TOTAL</td>
        <td class="num">${fmt(sumD)}</td>
        <td class="num">${fmt(sumC)}</td>
        <td class="num">${fmt(sumD - sumC)}</td>
      </tr>`;
    state.lastData = { type: 'tb', rows };
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
    tfoot.innerHTML = '';
  }
}

// ============================================================
// CASHFLOW
// ============================================================
async function loadCashflow() {
  const sumBody = document.getElementById('tbody-cf-summary');
  const detailBody = document.getElementById('tbody-cf-detail');
  document.getElementById('cfPeriod').textContent = periodLabel(state.from, state.to);
  sumBody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  detailBody.innerHTML = '';
  try {
    const { summary, rows } = await cashflow({ from: state.from, to: state.to });
    sumBody.innerHTML = summary.map(s => {
      const cls = s.net < 0 ? 'neg' : (s.net > 0 ? 'pos' : '');
      return `
        <tr>
          <td data-label="Kode">${esc(s.code)}</td>
          <td data-label="Akun">${esc(s.name)}</td>
          <td data-label="Masuk" class="num pos">${fmt(s.inflow)}</td>
          <td data-label="Keluar" class="num neg">${fmt(s.outflow)}</td>
          <td data-label="Net" class="num ${cls}">${fmt(s.net)}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="5" style="text-align:center;color:#9ca3af;">Tidak ada data</td></tr>';

    detailBody.innerHTML = rows.map(r => `
      <tr>
        <td data-label="Tanggal">${esc(r.journal_date)}</td>
        <td data-label="No">${esc(r.journal_no)}</td>
        <td data-label="Akun">${esc(r.account_code)} — ${esc(r.account_name)}</td>
        <td data-label="Deskripsi">${esc(r.description || '')}</td>
        <td data-label="Debit" class="num">${fmt(r.debit)}</td>
        <td data-label="Kredit" class="num">${fmt(r.credit)}</td>
      </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:#9ca3af;">Tidak ada mutasi</td></tr>';

    state.lastData = { type: 'cf', summary, rows };
  } catch (err) {
    sumBody.innerHTML = `<tr><td colspan="5" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

// ============================================================
// AGING PIUTANG
// ============================================================
async function loadAging() {
  const tbody = document.getElementById('tbody-ar');
  const tfoot = document.getElementById('tfoot-ar');
  document.getElementById('arPeriod').textContent = `Per ${state.to || new Date().toISOString().slice(0, 10)}`;
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  try {
    const rows = await agingPiutang({ asOf: state.to || null });
    let t0 = 0, t31 = 0, t60 = 0, tAll = 0;
    tbody.innerHTML = rows.map(r => {
      t0 += r.b0_30; t31 += r.b31_60; t60 += r.b60p; tAll += r.total;
      return `
        <tr>
          <td data-label="Pelanggan">${esc(r.name)}</td>
          <td data-label="0-30" class="num">${fmt(r.b0_30)}</td>
          <td data-label="31-60" class="num">${fmt(r.b31_60)}</td>
          <td data-label="60+" class="num">${fmt(r.b60p)}</td>
          <td data-label="Total" class="num">${fmt(r.total)}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="5" style="text-align:center;color:#9ca3af;">Tidak ada piutang</td></tr>';

    tfoot.innerHTML = `
      <tr class="report-total">
        <td>TOTAL</td>
        <td class="num">${fmt(t0)}</td>
        <td class="num">${fmt(t31)}</td>
        <td class="num">${fmt(t60)}</td>
        <td class="num">${fmt(tAll)}</td>
      </tr>`;
    state.lastData = { type: 'ar', rows };
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
    tfoot.innerHTML = '';
  }
}

// ============================================================
// AGING HUTANG
// ============================================================
async function loadAgingHutang() {
  const tbody = document.getElementById('tbody-ap');
  const tfoot = document.getElementById('tfoot-ap');
  document.getElementById('apPeriod').textContent = `Per ${state.to || new Date().toISOString().slice(0, 10)}`;
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  try {
    const rows = await agingHutang({ asOf: state.to || null });
    let t0 = 0, t31 = 0, t60 = 0, tAll = 0;
    tbody.innerHTML = rows.map(r => {
      t0 += r.b0_30; t31 += r.b31_60; t60 += r.b60p; tAll += r.total;
      return `
        <tr>
          <td data-label="Vendor">${esc(r.name)}</td>
          <td data-label="0-30" class="num">${fmt(r.b0_30)}</td>
          <td data-label="31-60" class="num">${fmt(r.b31_60)}</td>
          <td data-label="60+" class="num">${fmt(r.b60p)}</td>
          <td data-label="Total" class="num">${fmt(r.total)}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="5" style="text-align:center;color:#9ca3af;">Tidak ada hutang</td></tr>';

    tfoot.innerHTML = `
      <tr class="report-total">
        <td>TOTAL</td>
        <td class="num">${fmt(t0)}</td>
        <td class="num">${fmt(t31)}</td>
        <td class="num">${fmt(t60)}</td>
        <td class="num">${fmt(tAll)}</td>
      </tr>`;
    state.lastData = { type: 'ap', rows };
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
    tfoot.innerHTML = '';
  }
}

// ============================================================
// PENJUALAN PER SALES
// ============================================================
async function loadSalesReport() {
  const tbody = document.getElementById('tbody-sp');
  const tfoot = document.getElementById('tfoot-sp');
  document.getElementById('spPeriod').textContent = periodLabel(state.from, state.to);
  tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  tfoot.innerHTML = '';

  try {
    const { rows, totals } = await salesReport({ from: state.from, to: state.to });

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#9ca3af;">Tidak ada SO dalam periode ini</td></tr>';
      state.lastData = { type: 'sp', rows: [], totals };
      return;
    }

    tbody.innerHTML = rows.map(r => `
      <tr>
        <td data-label="Sales">
          <div style="font-weight:600;">${esc(r.sales_name)}</div>
          <div style="font-size:11px;color:#6b7280;">${esc(r.sales_email)}</div>
        </td>
        <td data-label="Total SO" class="num">${fmtInt(r.total_so)}</td>
        <td data-label="Draft" class="num">${fmtInt(r.draft)}</td>
        <td data-label="Pending" class="num">${fmtInt(r.pending)}</td>
        <td data-label="Approved" class="num">${fmtInt(r.approved)}</td>
        <td data-label="Posted" class="num pos">${fmtInt(r.posted)}</td>
        <td data-label="Rejected" class="num">${fmtInt(r.rejected)}</td>
        <td data-label="Cancelled" class="num">${fmtInt(r.cancelled)}</td>
        <td data-label="Total Posted" class="num">${fmt(r.total_posted)}</td>
        <td data-label="Total All" class="num">${fmt(r.total_all)}</td>
      </tr>`).join('');

    tfoot.innerHTML = `
      <tr class="report-total">
        <td>TOTAL</td>
        <td class="num">${fmtInt(totals.total_so)}</td>
        <td class="num">${fmtInt(totals.draft)}</td>
        <td class="num">${fmtInt(totals.pending)}</td>
        <td class="num">${fmtInt(totals.approved)}</td>
        <td class="num">${fmtInt(totals.posted)}</td>
        <td class="num">${fmtInt(totals.rejected)}</td>
        <td class="num">${fmtInt(totals.cancelled)}</td>
        <td class="num">${fmt(totals.total_posted)}</td>
        <td class="num">${fmt(totals.total_all)}</td>
      </tr>`;

    state.lastData = { type: 'sp', rows, totals };
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

// ============================================================
// LABA RUGI
// ============================================================
async function loadLabaRugi() {
  const tbody = document.getElementById('tbody-lr');
  document.getElementById('lrPeriod').textContent = periodLabel(state.from, state.to);
  tbody.innerHTML = '<tr><td style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  try {
    const r = await labaRugi({ from: state.from, to: state.to });
    const row = (label, val, cls = '') =>
      `<tr class="${cls}"><td>${esc(label)}</td><td class="num">${fmt(val)}</td></tr>`;
    const sectionTitle = t =>
      `<tr><td colspan="2" class="report-section-title">${esc(t)}</td></tr>`;

    let html = '';
    html += sectionTitle('Pendapatan');
    html += r.revenue.map(x => row(`${x.code} — ${x.name}`, x.balance)).join('');
    html += row('Total Pendapatan', r.totalRevenue, 'report-subtotal');
    html += sectionTitle('Harga Pokok Penjualan');
    html += r.hpp.map(x => row(`${x.code} — ${x.name}`, x.balance)).join('');
    html += row('Total HPP', r.totalHpp, 'report-subtotal');
    html += row('LABA KOTOR', r.grossProfit, 'report-grandtotal');
    html += sectionTitle('Beban Operasional');
    html += r.opex.map(x => row(`${x.code} — ${x.name}`, x.balance)).join('');
    html += row('Total Beban Operasional', r.totalOpex, 'report-subtotal');
    html += row('LABA OPERASIONAL', r.operatingProfit, 'report-grandtotal');
    if (r.otherExp.length) {
      html += sectionTitle('Beban Lain-lain');
      html += r.otherExp.map(x => row(`${x.code} — ${x.name}`, x.balance)).join('');
      html += row('Total Beban Lain-lain', r.totalOtherExp, 'report-subtotal');
    }
    html += row('LABA BERSIH', r.netProfit, 'report-grandtotal');
    tbody.innerHTML = html;
    state.lastData = { type: 'lr', data: r };
  } catch (err) {
    tbody.innerHTML = `<tr><td style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

// ============================================================
// NERACA
// ============================================================
async function loadNeraca() {
  const tbody = document.getElementById('tbody-nc');
  const status = document.getElementById('ncStatus');
  document.getElementById('ncPeriod').textContent = `Per ${state.to || new Date().toISOString().slice(0, 10)}`;
  tbody.innerHTML = '<tr><td style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  status.innerHTML = '';
  try {
    const n = await neraca({ asOf: state.to || null });
    const row = (label, val, cls = '') =>
      `<tr class="${cls}"><td>${esc(label)}</td><td class="num">${fmt(val)}</td></tr>`;
    const sectionTitle = t =>
      `<tr><td colspan="2" class="report-section-title">${esc(t)}</td></tr>`;

    let html = '';
    html += sectionTitle('ASET');
    html += n.asset.map(x => row(`${x.code} — ${x.name}`, x.balance)).join('');
    html += row('TOTAL ASET', n.totalAsset, 'report-grandtotal');
    html += sectionTitle('LIABILITAS');
    html += n.liability.map(x => row(`${x.code} — ${x.name}`, x.balance)).join('');
    html += row('Total Liabilitas', n.totalLiability, 'report-subtotal');
    html += sectionTitle('EKUITAS');
    html += n.equity.map(x => row(`${x.code} — ${x.name}`, x.balance)).join('');
    html += row('Laba Tahun Berjalan', n.currentProfit);
    html += row('TOTAL EKUITAS', n.totalEquity, 'report-subtotal');
    html += row('TOTAL LIABILITAS + EKUITAS', n.totalLiability + n.totalEquity, 'report-grandtotal');
    tbody.innerHTML = html;

    status.innerHTML = n.balanced
      ? `<div class="balance-indicator ok">✓ Neraca Balance (Aset = Liabilitas + Ekuitas)</div>`
      : `<div class="balance-indicator bad">⚠ Neraca Tidak Balance: selisih ${fmt(n.totalAsset - (n.totalLiability + n.totalEquity))}</div>`;
    state.lastData = { type: 'nc', data: n };
  } catch (err) {
    tbody.innerHTML = `<tr><td style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

// ============================================================
// CETAK PDF
// ============================================================
function printReport() {
  if (!state.perms.export) {
    toast('Tidak ada akses cetak laporan', true);
    return;
  }

  if (state.activeTab === 'bb') {
    toast('Cetak PDF Buku Besar belum tersedia — pakai Export CSV dulu', true);
    return;
  }

  const typeMap = {
    tb: 'tb', cf: 'cf', ar: 'ar', ap: 'ap', sp: 'sp', lr: 'lr', nc: 'nc'
  };

  const type = typeMap[state.activeTab];
  if (!type) {
    toast('Tipe laporan tidak dikenal', true);
    return;
  }

  const params = new URLSearchParams();
  params.set('type', type);
  if (state.from) params.set('from', state.from);
  if (state.to) params.set('to', state.to);

  window.open(`./reports-print.html?${params.toString()}`, '_blank');
}

// ============================================================
// EXPORT CSV
// ============================================================
function exportCsv() {
  if (!state.perms.export) { toast('Tidak ada akses export', true); return; }
  const d = state.lastData;
  if (!d) { toast('Tidak ada data untuk diexport', true); return; }

  let headers = [], rows = [], filename = '';
  if (d.type === 'tb') {
    filename = 'trial-balance';
    headers = ['Kode', 'Nama Akun', 'Tipe', 'Debit', 'Kredit', 'Saldo'];
    rows = d.rows.map(r => [r.code, r.name, r.type, r.total_debit, r.total_credit, r.balance]);
  } else if (d.type === 'cf') {
    filename = 'cashflow';
    headers = ['Tanggal', 'No. Jurnal', 'Akun', 'Deskripsi', 'Debit', 'Kredit'];
    rows = d.rows.map(r => [r.journal_date, r.journal_no, `${r.account_code} ${r.account_name}`, r.description, r.debit, r.credit]);
  } else if (d.type === 'ar') {
    filename = 'aging-piutang';
    headers = ['Pelanggan', '0-30', '31-60', '60+', 'Total'];
    rows = d.rows.map(r => [r.name, r.b0_30, r.b31_60, r.b60p, r.total]);
  } else if (d.type === 'ap') {
    filename = 'aging-hutang';
    headers = ['Vendor', '0-30', '31-60', '60+', 'Total'];
    rows = d.rows.map(r => [r.name, r.b0_30, r.b31_60, r.b60p, r.total]);
  } else if (d.type === 'sp') {
    filename = 'penjualan-per-sales';
    headers = ['Sales', 'Email', 'Total SO', 'Draft', 'Pending', 'Approved',
               'Posted', 'Rejected', 'Cancelled', 'Total Posted', 'Total All'];
    rows = d.rows.map(r => [
      r.sales_name, r.sales_email, r.total_so, r.draft, r.pending, r.approved,
      r.posted, r.rejected, r.cancelled, r.total_posted, r.total_all
    ]);
    if (d.totals) {
      rows.push([
        'TOTAL', '', d.totals.total_so, d.totals.draft, d.totals.pending,
        d.totals.approved, d.totals.posted, d.totals.rejected, d.totals.cancelled,
        d.totals.total_posted, d.totals.total_all
      ]);
    }
  } else if (d.type === 'lr') {
    filename = 'laba-rugi';
    headers = ['Keterangan', 'Nilai'];
    const r = d.data;
    rows = [
      ...r.revenue.map(x => [`Pendapatan: ${x.name}`, x.balance]),
      ['Total Pendapatan', r.totalRevenue],
      ...r.hpp.map(x => [`HPP: ${x.name}`, x.balance]),
      ['Total HPP', r.totalHpp],
      ['LABA KOTOR', r.grossProfit],
      ...r.opex.map(x => [`Beban: ${x.name}`, x.balance]),
      ['Total Beban Operasional', r.totalOpex],
      ['LABA OPERASIONAL', r.operatingProfit],
      ...r.otherExp.map(x => [`Beban Lain: ${x.name}`, x.balance]),
      ['LABA BERSIH', r.netProfit]
    ];
  } else if (d.type === 'nc') {
    filename = 'neraca';
    headers = ['Keterangan', 'Nilai'];
    const n = d.data;
    rows = [
      ...n.asset.map(x => [`Aset: ${x.name}`, x.balance]),
      ['TOTAL ASET', n.totalAsset],
      ...n.liability.map(x => [`Liabilitas: ${x.name}`, x.balance]),
      ['Total Liabilitas', n.totalLiability],
      ...n.equity.map(x => [`Ekuitas: ${x.name}`, x.balance]),
      ['Laba Tahun Berjalan', n.currentProfit],
      ['TOTAL EKUITAS', n.totalEquity],
      ['TOTAL LIABILITAS + EKUITAS', n.totalLiability + n.totalEquity]
    ];
  } else if (d.type === 'bb') {
    const g = d.data;
    filename = `buku-besar-${g.account.code}`;
    if (g.is_valas) {
      headers = ['Tanggal', 'No. Jurnal', 'Keterangan', 'Valuta', 'Kurs',
                 `Debit (${g.currency})`, `Kredit (${g.currency})`, `Saldo (${g.currency})`,
                 'Debit (Rp)', 'Kredit (Rp)', 'Saldo (Rp)'];
      rows = [
        ['', '', 'SALDO AWAL', g.currency, '', '', '', g.opening.native, '', '', g.opening.base],
        ...g.rows.map(r => [
          r.journal_date, r.journal_no, r.description, r.currency, r.exchange_rate || '',
          r.debit, r.credit,
          r.balance_native === null ? '' : r.balance_native,
          r.debit_base, r.credit_base, r.balance
        ]),
        ['', '', 'SALDO AKHIR', g.currency, '', '', '', g.totals.closing_native,
         g.totals.debit, g.totals.credit, g.totals.closing_base]
      ];
    } else {
      headers = ['Tanggal', 'No. Jurnal', 'Keterangan', 'Debit', 'Kredit', 'Saldo'];
      rows = [
        ['', '', 'SALDO AWAL', '', '', g.opening.base],
        ...g.rows.map(r => [
          r.journal_date, r.journal_no, r.description, r.debit_base, r.credit_base, r.balance
        ]),
        ['', '', 'SALDO AKHIR', g.totals.debit, g.totals.credit, g.totals.closing_base]
      ];
    }
  }

  const escapeCsv = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [headers, ...rows].map(r => r.map(escapeCsv).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const period = `${state.from || 'all'}_${state.to || 'all'}`;
  a.href = url;
  a.download = `${filename}_${period}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('CSV berhasil diunduh');
}