// js/cash-opname-page.js
// Page logic: Opname Saldo Kas & Bank (SQL-v11.27).
// Setiap kali file ini diubah: naikkan BUILD di bawah + query string
// di cash-opname.html (mis. ?v=11.27.1) supaya browser tidak pakai cache lama.

// Catatan: tidak memakai input-clear.js supaya input di dalam tabel (10 kolom)
// tidak dibungkus span 100% dan lebar kolom tetap stabil.
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission } from './permissions.js';
import {
  SELISIH_ACCOUNT_CODE,
  listCashBankAccounts,
  listCashBankOpnames,
  getCashBankOpname,
  createCashBankOpname,
  saveCashBankOpnameLines,
  refreshCashBankOpname,
  submitCashBankOpname,
  rejectCashBankOpname,
  cancelCashBankOpname,
  executeCashBankOpname,
  unpostCashBankOpname,
  getSelisihAccountBalance
} from './cash-bank-opname.js';

const BUILD = 'v11.27.0';
document.body.dataset.build = BUILD;
console.log('[cash-opname-page] build', BUILD);

const PAGE_SIZE = 100;

const state = {
  perms: { view: false, create: false, execute: false },
  accounts: [],
  hist: [],
  offset: 0,
  hasMore: false,
  currentId: null,
  header: null,
  lines: [],
  summary: null,
  preview: null,
  creating: false
};

// ---------------- helper tampilan (pola sama dengan inventory-page) ----------------
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => el.className = 'toast', 3600);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function fmt(n) {
  return Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });
}
function fmtDate(iso) {
  if (!iso) return '—';
  const p = String(iso).slice(0, 10).split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : String(iso);
}
function fmtDateTime(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('id-ID'); } catch { return esc(ts); }
}
function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// angka untuk atribut value input type=number (pakai titik desimal)
function numInput(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '';
}
// pesan error RPC Supabase -> teks bersih
function errMsg(e) {
  const raw = (e && (e.message || e.details || e.hint)) ? (e.message || e.details || e.hint) : String(e || '');
  let m = String(raw || '').trim();
  m = m.replace(/^(ERROR|error|Error)\s*:\s*/, '');
  return m || 'Terjadi kesalahan';
}
function statusBadge(status) {
  const map = {
    draft:     { bg:'#e5e7eb', fg:'#374151', label:'Draft' },
    submitted: { bg:'#fef3c7', fg:'#92400e', label:'Submitted' },
    executed:  { bg:'#d1fae5', fg:'#065f46', label:'Executed' },
    cancelled: { bg:'#fee2e2', fg:'#991b1b', label:'Cancelled' }
  };
  const s = map[status] || { bg:'#e5e7eb', fg:'#374151', label: status || '—' };
  return `<span style="background:${s.bg};color:${s.fg};padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px;">${esc(s.label)}</span>`;
}
function deltaColor(v) {
  if (v === null || v === undefined) return '#6b7280';
  if (Math.abs(Number(v)) < 0.005) return '#374151';
  return Number(v) > 0 ? '#065f46' : '#991b1b';
}
// ---------------- init ----------------
(async function init() {
  const user = await requireAuth();
  if (!user) return;

  const role = await requirePageAccess('cash-opname');
  if (!role) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  await renderNav(document.getElementById('mainNav'), 'cash-opname');

  state.perms.view    = await hasPermission('finance.cash_opname.view');
  state.perms.create  = await hasPermission('finance.cash_opname.create');
  state.perms.execute = await hasPermission('finance.cash_opname.execute');

  if (!state.perms.view) {
    toast('Anda tidak punya izin melihat opname kas & bank.', true);
    return;
  }

  document.getElementById('btnNew').style.display = state.perms.create ? '' : 'none';
  document.getElementById('newDate').value = todayISO();

  wireEvents();
  await Promise.all([loadAccounts(), reloadHistory(true), refreshSelisihCard()]);

  const qid = new URLSearchParams(location.search).get('id');
  if (qid && Number(qid) > 0) openDetail(Number(qid));
})();

function wireEvents() {
  const byId = (id) => document.getElementById(id);

  byId('btnNew').addEventListener('click', () => {
    const card = byId('newCard');
    card.style.display = card.style.display === 'none' ? '' : 'none';
    if (card.style.display !== 'none') byId('newDate').focus();
  });
  byId('btnCancelNew').addEventListener('click', () => { byId('newCard').style.display = 'none'; });
  byId('form-new').addEventListener('submit', onCreate);
  byId('btnPickAll').addEventListener('click', () => setAllAccounts(true));
  byId('btnPickNone').addEventListener('click', () => setAllAccounts(false));

  byId('btnReload').addEventListener('click', () => reloadHistory(true));
  byId('btnReloadTop').addEventListener('click', () => {
    reloadHistory(true);
    refreshSelisihCard();
  });
  byId('btnMore').addEventListener('click', () => reloadHistory(false));
  byId('histStatus').addEventListener('change', () => reloadHistory(true));

  byId('lineSearch').addEventListener('input', renderLines);
  byId('onlyDelta').addEventListener('change', renderLines);

  byId('btnCancelPreview').addEventListener('click', () => {
    state.preview = null;
    byId('previewCard').style.display = 'none';
  });
  byId('btnConfirmExecute').addEventListener('click', onExecuteConfirm);
}

// ---------------- akun opname ----------------
async function loadAccounts() {
  const box = document.getElementById('accountPicker');
  try {
    state.accounts = await listCashBankAccounts();
  } catch (e) {
    box.innerHTML = `<span style="font-size:13px;color:#dc2626;">Gagal memuat akun: ${esc(errMsg(e))}</span>`;
    return;
  }
  if (!state.accounts.length) {
    box.innerHTML = '<span style="font-size:13px;color:#dc2626;">Tidak ada akun kas/bank aktif (kode 1-10xx / 1-11xx).</span>';
    return;
  }
  box.innerHTML = state.accounts.map(a => `
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;">
      <input type="checkbox" name="acc" value="${esc(a.code)}" checked>
      <span><b>${esc(a.code)}</b> ${esc(a.name)}</span>
    </label>`).join('');
}

function setAllAccounts(on) {
  document.querySelectorAll('#accountPicker input[name="acc"]')
    .forEach(el => { el.checked = !!on; });
}

async function onCreate(ev) {
  ev.preventDefault();
  if (state.creating) return;

  const dateEl  = document.getElementById('newDate');
  const notesEl = document.getElementById('newNotes');
  const opnameDate = dateEl.value;
  if (!opnameDate) { toast('Tanggal opname wajib diisi.', true); return; }

  const boxes = Array.from(document.querySelectorAll('#accountPicker input[name="acc"]'));
  const picked = boxes.filter(el => el.checked).map(el => el.value);
  if (!picked.length) { toast('Pilih minimal satu akun kas/bank.', true); return; }
  const codes = picked.length === boxes.length ? null : picked;

  const btn = document.getElementById('btnCreate');
  state.creating = true;
  btn.disabled = true;
  btn.textContent = 'Menyimpan…';
  try {
    const row = await createCashBankOpname({
      opnameDate,
      notes: notesEl.value.trim() || null,
      accountCodes: codes
    });
    toast(`Opname ${row.opname_no} dibuat (${row.line_count} akun).`);
    notesEl.value = '';
    document.getElementById('newCard').style.display = 'none';
    await reloadHistory(true);
    await openDetail(row.opname_id);
  } catch (e) {
    toast(errMsg(e), true);
  } finally {
    state.creating = false;
    btn.disabled = false;
    btn.textContent = 'Buat Opname';
  }
}
// ---------------- daftar riwayat ----------------
async function reloadHistory(reset = true) {
  if (reset) { state.offset = 0; state.hist = []; }
  const btnMore = document.getElementById('btnMore');
  btnMore.disabled = true;
  try {
    const rows = await listCashBankOpnames({
      from: document.getElementById('histFrom').value || null,
      to: document.getElementById('histTo').value || null,
      status: document.getElementById('histStatus').value || null,
      limit: PAGE_SIZE,
      offset: state.offset
    });
    const seen = new Set(state.hist.map(r => Number(r.opname_id)));
    const add = rows.filter(r => !seen.has(Number(r.opname_id)));
    state.hist = reset ? rows : state.hist.concat(add);
    state.hasMore = rows.length === PAGE_SIZE;
    state.offset += rows.length;
    renderHistory();
  } catch (e) {
    document.getElementById('tbodyHist').innerHTML =
      `<tr><td colspan="8" style="text-align:center;color:#dc2626;padding:12px;">${esc(errMsg(e))}</td></tr>`;
    document.getElementById('histInfo').textContent = '';
    document.getElementById('btnMore').style.display = 'none';
  } finally {
    btnMore.disabled = false;
  }
}

function renderHistory() {
  const tb = document.getElementById('tbodyHist');
  if (!state.hist.length) {
    tb.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#6b7280;padding:16px;">Belum ada opname pada filter ini.</td></tr>';
  } else {
    tb.innerHTML = state.hist.map(r => {
      const total = Number(r.total_selisih_idr || 0);
      const active = Number(r.opname_id) === Number(state.currentId);
      return `<tr data-id="${r.opname_id}" style="cursor:pointer;${active ? 'background:#eff6ff;' : ''}">
        <td data-label="No. Opname"><b>${esc(r.opname_no)}</b></td>
        <td data-label="Tanggal">${fmtDate(r.opname_date)}</td>
        <td data-label="Status">${statusBadge(r.status)}</td>
        <td class="num" data-label="Akun">${esc(r.line_count ?? 0)}</td>
        <td class="num" data-label="Disesuaikan">${esc(r.adjusted_count ?? 0)}</td>
        <td class="num" data-label="Total Selisih (Rp)" style="color:${deltaColor(total)};font-weight:600;">${fmt(total)}</td>
        <td data-label="Jurnal">${r.journal_no ? esc(r.journal_no) : '—'}</td>
        <td data-label="Aksi">
          <button type="button" class="btn btn-secondary" data-open="${r.opname_id}"
                  style="padding:4px 10px;font-size:12px;">Buka</button>
        </td>
      </tr>`;
    }).join('');

    tb.querySelectorAll('tr[data-id]').forEach(tr => {
      tr.addEventListener('click', (ev) => {
        if (ev.target.closest('button[data-open]')) return;
        openDetail(Number(tr.dataset.id));
      });
    });
    tb.querySelectorAll('button[data-open]').forEach(b => {
      b.addEventListener('click', () => openDetail(Number(b.dataset.open)));
    });
  }

  document.getElementById('btnMore').style.display = state.hasMore ? '' : 'none';
  document.getElementById('histInfo').textContent = state.hist.length
    ? `Menampilkan ${state.hist.length} opname${state.hasMore ? ' (masih ada lagi)' : ''}.`
    : '';
}

// ---------------- detail ----------------
async function openDetail(id) {
  if (!id) return;
  state.currentId = id;
  state.header = null;
  state.lines = [];
  state.summary = null;
  state.preview = null;

  const card = document.getElementById('detailCard');
  card.style.display = '';
  document.getElementById('previewCard').style.display = 'none';
  document.getElementById('detailHeader').innerHTML = '<span style="font-size:13px;color:#6b7280;">Memuat…</span>';
  document.getElementById('actionBar').innerHTML = '';
  document.getElementById('tbodyLines').innerHTML = '';
  document.getElementById('tfootLines').innerHTML = '';
  document.getElementById('detailNote').textContent = '';
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });

  await loadDetail();
  renderHistory();
}

async function loadDetail() {
  const id = state.currentId;
  if (!id) return;
  try {
    const res = await getCashBankOpname(id);
    if (state.currentId !== id) return; // user sudah pindah ke opname lain

    state.header  = res.header || {};
    state.summary = res.summary || {};
    state.lines = (res.lines || []).map(l => ({
      line_id: Number(l.line_id),
      account_id: Number(l.account_id),
      account_code: l.account_code,
      account_name: l.account_name,
      currency_code: (l.currency_code || 'IDR').trim(),
      saldo_sistem: Number(l.saldo_sistem || 0),
      saldo_fisik: (l.saldo_fisik === null || l.saldo_fisik === undefined) ? null : Number(l.saldo_fisik),
      exchange_rate: Number(l.exchange_rate || 1),
      memo: l.memo || ''
    }));

    renderDetailHeader();
    renderActions();
    renderLines();
    if (state.summary.selisih_account_balance !== undefined) {
      setSelisihCard(state.summary.selisih_account_balance);
    }
  } catch (e) {
    document.getElementById('detailHeader').innerHTML =
      `<span style="color:#dc2626;font-size:13px;">${esc(errMsg(e))}</span>`;
  }
}
function statusOf() {
  return (state.header && state.header.status) || '';
}
function canEdit() {
  return state.perms.create && (statusOf() === 'draft' || statusOf() === 'submitted');
}

function renderDetailHeader() {
  const h = state.header || {};
  const st = statusOf();
  const info = [];

  info.push(`<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
    <span style="font-size:17px;font-weight:700;">${esc(h.opname_no || '')}</span>
    ${statusBadge(st)}
    ${h.journal_no ? `<span style="font-size:12px;background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:4px;font-weight:600;">Jurnal ${esc(h.journal_no)}</span>` : ''}
  </div>`);

  const parts = [`Tanggal <b>${fmtDate(h.opname_date)}</b>`];
  if (h.notes) parts.push(esc(h.notes));
  if (state.summary) {
    parts.push(`${esc(state.summary.filled_count ?? 0)} akun terisi`);
    parts.push(`${esc(state.summary.adjusted_count ?? 0)} berselisih`);
  }
  info.push(`<div style="font-size:13px;color:#374151;margin-top:6px;">${parts.join(' · ')}</div>`);

  if (h.review_note) {
    info.push(`<div style="font-size:13px;color:#b45309;margin-top:4px;">Catatan review: ${esc(h.review_note)}</div>`);
  }
  if (h.cancel_reason) {
    info.push(`<div style="font-size:13px;color:#991b1b;margin-top:4px;">Alasan batal: ${esc(h.cancel_reason)}</div>`);
  }
  if (h.submitted_at) {
    info.push(`<div style="font-size:12px;color:#6b7280;margin-top:4px;">Disubmit: ${fmtDateTime(h.submitted_at)}</div>`);
  }
  if (h.executed_at) {
    info.push(`<div style="font-size:12px;color:#6b7280;margin-top:2px;">Dieksekusi: ${fmtDateTime(h.executed_at)}</div>`);
  }
  if (st === 'cancelled' && h.reversal_journal_id) {
    info.push(`<div style="font-size:12px;color:#991b1b;margin-top:2px;">Jurnal reversal dibuat (id #${esc(h.reversal_journal_id)}). Jurnal asli tetap ada untuk audit.</div>`);
  }

  document.getElementById('detailHeader').innerHTML = info.join('');
}

function renderActions() {
  const st = statusOf();
  const btns = [];

  if (canEdit()) {
    btns.push('<button type="button" class="btn btn-primary" data-act="save">Simpan Saldo Fisik</button>');
    btns.push('<button type="button" class="btn btn-secondary" data-act="refresh">Refresh Saldo Buku</button>');
  }
  if (st === 'draft' && state.perms.create) {
    btns.push('<button type="button" class="btn btn-primary" data-act="submit">Submit untuk Eksekusi</button>');
  }
  if (st === 'submitted' && state.perms.execute) {
    btns.push('<button type="button" class="btn btn-primary" data-act="execute">Eksekusi (Pratinjau)</button>');
    btns.push('<button type="button" class="btn btn-secondary" data-act="reject">Tolak</button>');
  }
  if ((st === 'draft' || st === 'submitted') && state.perms.create) {
    btns.push('<button type="button" class="btn btn-danger" data-act="cancel">Batalkan Opname</button>');
  }
  if (st === 'executed' && state.perms.execute) {
    btns.push('<button type="button" class="btn btn-danger" data-act="unpost">Unpost (Jurnal Reversal)</button>');
  }
  if (!btns.length) {
    btns.push('<span style="font-size:13px;color:#6b7280;">Tidak ada aksi untuk status ini dengan izin Anda.</span>');
  }

  const bar = document.getElementById('actionBar');
  bar.innerHTML = btns.join(' ');
  bar.querySelectorAll('button[data-act]').forEach(b => {
    b.addEventListener('click', () => onAction(b.dataset.act, b));
  });
}

async function onAction(act, btn) {
  if (!state.currentId) return;
  const label = btn.textContent;
  btn.disabled = true;
  try {
    if (act === 'save')          await onSave();
    else if (act === 'refresh')  await onRefreshSaldo();
    else if (act === 'submit')   await onSubmit();
    else if (act === 'execute')  await onPreviewExecute();
    else if (act === 'reject')   await onReject();
    else if (act === 'cancel')   await onCancel();
    else if (act === 'unpost')   await onUnpost();
  } catch (e) {
    toast(errMsg(e), true);
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}
// ---------------- tabel baris opname ----------------
function renderLines() {
  const tb = document.getElementById('tbodyLines');
  const q = (document.getElementById('lineSearch').value || '').trim().toLowerCase();
  const onlyDelta = document.getElementById('onlyDelta').checked;
  const editable = canEdit();

  const rows = state.lines.filter(l => {
    if (q && !(`${l.account_code} ${l.account_name}`.toLowerCase().includes(q))) return false;
    if (onlyDelta) {
      if (l.saldo_fisik === null) return false;
      if (Math.abs(Number(l.saldo_fisik) - Number(l.saldo_sistem)) < 0.005) return false;
    }
    return true;
  });

  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="10" style="text-align:center;color:#6b7280;padding:16px;">${state.lines.length ? 'Tidak ada akun yang cocok dengan filter.' : 'Tidak ada baris.'}</td></tr>`;
  } else {
    tb.innerHTML = rows.map(l => {
      const isIdr = l.currency_code === 'IDR';
      const rate  = isIdr ? 1 : Number(l.exchange_rate || 0);
      const saldoRp = isIdr ? Number(l.saldo_sistem) : (rate > 0 ? Number(l.saldo_sistem) * rate : null);
      const fisik = l.saldo_fisik;
      const delta = (fisik === null) ? null : Number(fisik) - Number(l.saldo_sistem);
      const deltaIdr = delta === null ? null : Math.round(delta * rate * 100) / 100;
      const color = deltaColor(delta);

      return `<tr data-acc="${l.account_id}">
        <td data-label="Kode"><b>${esc(l.account_code)}</b></td>
        <td data-label="Akun">${esc(l.account_name)}</td>
        <td data-label="Cur">${esc(l.currency_code)}</td>
        <td class="num" data-label="Saldo Buku (Valas)">${fmt(l.saldo_sistem)}</td>
        <td class="num" data-label="Saldo Buku (Rp)">${saldoRp === null ? '—' : fmt(saldoRp)}</td>
        <td data-label="Saldo Fisik">
          <input type="number" step="0.01" class="cbo-fisik" data-acc="${l.account_id}"
                 value="${numInput(fisik)}" ${editable ? '' : 'disabled'}
                 style="width:130px;padding:6px;border:1px solid #d0d5dd;border-radius:6px;text-align:right;">
        </td>
        <td class="num cbo-delta" data-label="Selisih" style="color:${color};font-weight:600;">${delta === null ? '—' : fmt(delta)}</td>
        <td data-label="Kurs">
          <input type="number" step="0.01" min="0" class="cbo-rate" data-acc="${l.account_id}"
                 value="${isIdr ? '1' : numInput(l.exchange_rate)}"
                 ${(editable && !isIdr) ? '' : 'disabled'}
                 style="width:100px;padding:6px;border:1px solid #d0d5dd;border-radius:6px;text-align:right;">
        </td>
        <td class="num cbo-deltaidr" data-label="Selisih (Rp)" style="color:${color};font-weight:600;">${deltaIdr === null ? '—' : fmt(deltaIdr)}</td>
        <td data-label="Memo">
          <input type="text" class="cbo-memo" data-acc="${l.account_id}" maxlength="255"
                 value="${esc(l.memo || '')}" ${editable ? '' : 'disabled'}
                 placeholder="mis. disimpan di brankas"
                 style="width:100%;min-width:140px;padding:6px;border:1px solid #d0d5dd;border-radius:6px;">
        </td>
      </tr>`;
    }).join('');

    tb.querySelectorAll('.cbo-fisik, .cbo-rate, .cbo-memo').forEach(inp => {
      inp.addEventListener('input', onLineInput);
      inp.addEventListener('change', onLineInput);
    });
  }

  renderTotals();

  const note = document.getElementById('detailNote');
  if (!state.lines.length) {
    note.textContent = '';
  } else if (canEdit()) {
    note.textContent = 'Isi saldo fisik hanya untuk akun yang benar-benar dihitung. Akun yang dikosongkan tidak dijurnal. '
      + 'Nilai "Saldo Buku (Rp)" akun valas = saldo valas × kurs di kolom Kurs (kurs ini yang dipakai saat menjurnal), bukan nilai buku historis.';
  } else {
    note.textContent = 'Opname hanya bisa dibaca (status atau izin Anda tidak memungkinkan pengisian). '
      + 'Nilai "Saldo Buku (Rp)" akun valas dihitung dari kurs yang tersimpan di baris.';
  }
}
function onLineInput(ev) {
  const inp = ev.target;
  const acc = Number(inp.dataset.acc);
  const line = state.lines.find(l => Number(l.account_id) === acc);
  if (!line) return;

  if (inp.classList.contains('cbo-fisik')) {
    line.saldo_fisik = inp.value === '' ? null : Number(inp.value);
  } else if (inp.classList.contains('cbo-rate')) {
    const v = Number(inp.value);
    line.exchange_rate = (Number.isFinite(v) && v > 0) ? v : 1;
  } else if (inp.classList.contains('cbo-memo')) {
    line.memo = inp.value;
  }

  const tr = inp.closest('tr');
  if (!tr) return;

  const isIdr = line.currency_code === 'IDR';
  const rate  = isIdr ? 1 : Number(line.exchange_rate || 0);
  const delta = (line.saldo_fisik === null) ? null : Number(line.saldo_fisik) - Number(line.saldo_sistem);
  const deltaIdr = delta === null ? null : Math.round(delta * rate * 100) / 100;
  const color = deltaColor(delta);

  const rateInp = tr.querySelector('input.cbo-rate');
  if (rateInp && isIdr) rateInp.value = '1';

  const dCell = tr.querySelector('.cbo-delta');
  if (dCell) {
    dCell.textContent = delta === null ? '—' : fmt(delta);
    dCell.style.color = color;
  }
  const dIdrCell = tr.querySelector('.cbo-deltaidr');
  if (dIdrCell) {
    dIdrCell.textContent = deltaIdr === null ? '—' : fmt(deltaIdr);
    dIdrCell.style.color = color;
  }

  renderTotals();
}

function renderTotals() {
  const tf = document.getElementById('tfootLines');
  if (!state.lines.length) { tf.innerHTML = ''; return; }

  let filled = 0, adjusted = 0, total = 0;
  for (const l of state.lines) {
    if (l.saldo_fisik === null) continue;
    filled++;
    const isIdr = l.currency_code === 'IDR';
    const rate  = isIdr ? 1 : Number(l.exchange_rate || 0);
    const delta = Number(l.saldo_fisik) - Number(l.saldo_sistem);
    const base  = Math.round(delta * rate * 100) / 100;
    total += base;
    if (Math.abs(delta) >= 0.005 && Math.abs(base) >= 0.005) adjusted++;
  }
  total = Math.round(total * 100) / 100;

  tf.innerHTML = `<tr style="background:#f9fafb;font-weight:700;">
    <td colspan="8" data-label="Total">Total ${filled} akun terisi · ${adjusted} berselisih · total selisih (Rp)</td>
    <td class="num" data-label="Total Selisih (Rp)" style="color:${deltaColor(total)};">${fmt(total)}</td>
    <td></td>
  </tr>`;
}

// Kirim SEMUA baris supaya akun yang dikosongkan ikut jadi NULL di database.
function collectLines() {
  return state.lines.map(l => ({
    account_id: l.account_id,
    saldo_fisik: l.saldo_fisik === null ? null : Number(l.saldo_fisik),
    exchange_rate: Number(l.exchange_rate) > 0 ? Number(l.exchange_rate) : null,
    memo: (l.memo || '').trim() || null
  }));
}

// ---------------- kartu saldo akun 1-1900 ----------------
function setSelisihCard(balance, hint) {
  const el = document.getElementById('selisihBalance');
  const v = Number(balance || 0);
  const clean = Math.abs(v) < 0.005;
  el.textContent = 'Rp ' + fmt(v);
  el.style.color = clean ? '#065f46' : (v > 0 ? '#1e40af' : '#991b1b');
  document.getElementById('selisihHint').textContent = hint !== undefined
    ? hint
    : (clean ? 'Bersih ✓ (tidak ada selisih menggantung)'
        : (v > 0
            ? 'Saldo debit = selisih kurang (fisik < buku) belum ditelusuri'
            : 'Saldo kredit = selisih lebih (fisik > buku) belum ditelusuri'));
}

async function refreshSelisihCard() {
  try {
    const bal = await getSelisihAccountBalance(SELISIH_ACCOUNT_CODE);
    setSelisihCard(bal);
  } catch (e) {
    document.getElementById('selisihBalance').textContent = '—';
    document.getElementById('selisihHint').textContent = 'Gagal memuat saldo: ' + errMsg(e);
  }
}
// ---------------- aksi: simpan / refresh / submit ----------------
async function onSave() {
  const res = await saveCashBankOpnameLines(state.currentId, collectLines());
  toast(`Tersimpan. ${res.filled_count ?? 0} akun terisi, ${res.adjusted_count ?? 0} berselisih, total Rp ${fmt(res.total_selisih_idr)}.`);
  await loadDetail();
  await reloadHistory(true);
}

async function onRefreshSaldo() {
  const ok = confirm('Refresh saldo buku dari jurnal?\n\nSaldo fisik yang sedang Anda isi akan disimpan dulu, lalu snapshot saldo buku dihitung ulang.');
  if (!ok) return;
  await saveCashBankOpnameLines(state.currentId, collectLines());
  const res = await refreshCashBankOpname(state.currentId);
  toast(`Saldo buku diperbarui. ${res.filled_count ?? 0} akun terisi, total selisih Rp ${fmt(res.total_selisih_idr)}.`);
  await loadDetail();
  await reloadHistory(true);
  await refreshSelisihCard();
}

async function onSubmit() {
  const ok = confirm('Submit opname ini?\n\nSetelah submit, opname menunggu eksekusi (posting jurnal) oleh pemegang izin eksekusi.');
  if (!ok) return;
  await saveCashBankOpnameLines(state.currentId, collectLines());
  const res = await submitCashBankOpname(state.currentId);
  toast(`Opname disubmit. ${res.filled_count ?? 0} akun terisi, ${res.adjusted_count ?? 0} berselisih.`);
  await loadDetail();
  await reloadHistory(true);
}

// ---------------- aksi: tolak / batalkan / unpost ----------------
async function onReject() {
  const reason = prompt('Alasan penolakan (wajib diisi):');
  if (reason === null) return;
  if (!reason.trim()) { toast('Alasan penolakan wajib diisi.', true); return; }
  const res = await rejectCashBankOpname(state.currentId, reason.trim());
  toast(`Opname ditolak, status kembali draft. Catatan: ${res.review_note || reason.trim()}`);
  await loadDetail();
  await reloadHistory(true);
}

async function onCancel() {
  const reason = prompt('Alasan pembatalan (wajib diisi):');
  if (reason === null) return;
  if (!reason.trim()) { toast('Alasan pembatalan wajib diisi.', true); return; }
  await cancelCashBankOpname(state.currentId, reason.trim());
  toast('Opname dibatalkan (belum ada jurnal).');
  await loadDetail();
  await reloadHistory(true);
}

async function onUnpost() {
  const ok = confirm('Unpost opname ini?\n\nSistem akan membuat jurnal REVERSAL bertanggal HARI INI dan status opname menjadi Cancelled.\nJurnal OPK asli tetap tersimpan sebagai jejak audit.');
  if (!ok) return;
  const res = await unpostCashBankOpname(state.currentId);
  if (res.already_unposted) {
    toast(`Opname sudah pernah di-unpost (jurnal reversal id #${res.journal_id}).`);
  } else {
    toast(`Reversal ${res.reversal_journal_no || ''} dibuat untuk ${res.journal_no || ''} (${res.line_count ?? 0} baris).`);
  }
  await loadDetail();
  await reloadHistory(true);
  await refreshSelisihCard();
}
// ---------------- aksi: eksekusi (dry run dulu, lalu posting) ----------------
async function onPreviewExecute() {
  const res = await executeCashBankOpname(state.currentId, true);
  state.preview = res;
  renderPreview(res);
}

function renderPreview(res) {
  const card = document.getElementById('previewCard');
  card.style.display = '';

  const lines = Array.isArray(res.lines) ? res.lines : [];
  const settle = Number(res.total_selisih_idr || 0);
  const accSelisih = res.selisih_account_code || SELISIH_ACCOUNT_CODE;

  document.getElementById('previewMeta').innerHTML = `
    <div>Opname <b>${esc(res.opname_no || '')}</b> tanggal <b>${fmtDate(res.opname_date)}</b>
      · ${lines.length} akun berselisih · total selisih (Rp): <b style="color:${deltaColor(settle)};">${fmt(settle)}</b></div>
    <div style="color:#6b7280;margin-top:2px;">
      Akun lawan: <b>${esc(accSelisih)}</b> Selisih Sementara Kas &amp; Bank.
      Total selisih positif = fisik lebih (akun kas/bank didebit, ${esc(accSelisih)} dikredit);
      negatif = fisik kurang (akun kas/bank dikredit).
    </div>`;

  const rows = lines.map(it => {
    const delta = Number(it.delta || 0);
    const base  = Number(it.base || 0);
    const cur   = (it.currency_code || 'IDR').trim();
    const suffix = cur === 'IDR' ? '' : ' ' + esc(cur);
    return `<tr>
      <td data-label="Akun"><b>${esc(it.account_code)}</b> ${esc(it.account_name)}</td>
      <td data-label="Keterangan">Opname ${esc(res.opname_no)} — ${delta > 0 ? 'fisik &gt; buku' : 'fisik &lt; buku'}</td>
      <td class="num" data-label="Debit">${delta > 0 ? fmt(delta) + suffix : '—'}</td>
      <td class="num" data-label="Kredit">${delta < 0 ? fmt(-delta) + suffix : '—'}</td>
      <td class="num" data-label="Debit (Rp)">${delta > 0 ? fmt(base) : '—'}</td>
      <td class="num" data-label="Kredit (Rp)">${delta < 0 ? fmt(-base) : '—'}</td>
    </tr>`;
  });

  if (Math.abs(settle) >= 0.005) {
    rows.push(`<tr style="background:#f9fafb;">
      <td data-label="Akun"><b>${esc(accSelisih)}</b> Selisih Sementara Kas &amp; Bank</td>
      <td data-label="Keterangan">Selisih opname ${esc(res.opname_no)}</td>
      <td class="num" data-label="Debit">—</td>
      <td class="num" data-label="Kredit">—</td>
      <td class="num" data-label="Debit (Rp)">${settle < 0 ? fmt(-settle) : '—'}</td>
      <td class="num" data-label="Kredit (Rp)">${settle > 0 ? fmt(settle) : '—'}</td>
    </tr>`);
  }

  document.getElementById('tbodyPreview').innerHTML = rows.join('');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function onExecuteConfirm() {
  if (!state.preview) {
    toast('Pratinjau tidak tersedia. Klik "Eksekusi (Pratinjau)" dulu.', true);
    return;
  }
  const btn = document.getElementById('btnConfirmExecute');
  btn.disabled = true;
  btn.textContent = 'Memposting…';
  try {
    const res = await executeCashBankOpname(state.currentId, false);
    state.preview = null;
    document.getElementById('previewCard').style.display = 'none';
    toast(`Jurnal ${res.journal_no} diposting (${res.line_count ?? 0} baris akun, total selisih Rp ${fmt(res.total_selisih_idr)}).`);
    await loadDetail();
    await reloadHistory(true);
    await refreshSelisihCard();
  } catch (e) {
    toast(errMsg(e), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Posting Sekarang';
  }
}
