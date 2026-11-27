// js/hutang-page.js
import { supabase } from './supabase-client.js';
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission, preloadPermissions } from './permissions.js';
import { agingHutang } from './reports.js';
import { getValasBookRate } from './bank-accounts.js';
import {
  listPaymentPlans, addPaymentPlan, updatePaymentPlan,
  movePaymentPlan, deletePaymentPlan
} from './payment-plans.js?v=11.34';

// ============================================================
// UTIL
// ============================================================
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => el.className = 'toast', 2600);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function fmt(n) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  if (isNaN(num)) return '—';
  return num.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('id-ID');
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}
function statusBadge(s) {
  const map = {
    posted:  { bg: '#e5e7eb', color: '#374151', label: 'Posted' },
    partial: { bg: '#fef3c7', color: '#92400e', label: 'Partial' },
    paid:    { bg: '#d1fae5', color: '#065f46', label: 'Paid' }
  };
  const m = map[s] || { bg: '#f3f4f6', color: '#6b7280', label: s || '—' };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:${m.bg};color:${m.color};">${esc(m.label)}</span>`;
}
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function downloadCSV(filename, headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  rows.forEach(r => lines.push(r.map(csvEscape).join(',')));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}
// Parser angka tahan format: "1500000", "1.500.000", "1500,5", "1.500,50",
// "7,371.50", "7371.5", "USD 7.371,50". Pemisah desimal ditentukan dari posisi
// pemisah terakhir supaya tidak salah baca (mis. 7,371.50 jangan jadi 7,37).
function parseAmountSmart(raw, defaultDecimal) {
  let t = String(raw ?? '').trim().replace(/[\s']/g, '');
  if (!t) return NaN;
  t = t.replace(/^(rp|usd|\$)/i, '').replace(/(rp|usd)$/i, '');
  if (!t) return NaN;

  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  let decSep = null;

  if (lastDot >= 0 && lastComma >= 0) {
    decSep = lastDot > lastComma ? '.' : ',';
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const sepPos = lastDot >= 0 ? lastDot : lastComma;
    const digitsAfter = t.length - sepPos - 1;
    const occurrences = t.split(sep).length - 1;
    if (occurrences > 1) decSep = null;                      // 1.500.000 = ribuan
    else if (digitsAfter === 3 && sep !== defaultDecimal) decSep = null; // 1.500 / 7,371 = ribuan
    else decSep = sep;
  }

  let norm = t;
  if (decSep) {
    const thousands = decSep === '.' ? ',' : '.';
    norm = norm.split(thousands).join('');
    if (decSep === ',') norm = norm.replace(',', '.');
  } else {
    norm = norm.replace(/[.,]/g, '');
  }
  return Number(norm);
}
// IDR: koma = desimal (default), titik = ribuan.
function parseNumberId(s) {
  return parseAmountSmart(s, ',');
}
// USD: titik = desimal (default), koma = ribuan.
function parseNumberUsd(s) {
  return parseAmountSmart(s, '.');
}

// ============================================================
// STATE
// ============================================================
const PAGE_SIZE = 50;
const state = {
  activeTab: 'invoice',
  page: 1,
  filters: { search: '', partner_id: '', status: '', currency: '', from: '', to: '' },
  total: 0,
  canExport: false,
  canViewInvoice: false,
  canViewAging: false,
  canCreatePayment: false,
  canDeletePayment: false,
  canManage: false,
  payFilters: { search: '', from: '', to: '' },
  payInvoicesCache: [],
  paymentsLoaded: false,
  bankAccounts: [],
  clearingLoaded: false,
  allocRowCount: 0,
  clearingInvoices: [],
  payAllocCount: 0,
  // Kurs buku rata-rata stok valas (auto-fill, boleh diubah manual)
  bookRate: null,
  bookRateReq: 0,
  payRateTouched: false,
  // Rencana Bayar (antrian prioritas, SQL-v11.33)
  canViewPlan: false,
  canManagePlan: false,
  plans: [],
  plansLoaded: false,
  planInvoiceSearch: ''
};

// ============================================================
// HELPER: Cari partner_id by search
// ============================================================
async function findPartnerIdsBySearch(search) {
  if (!search) return [];
  const { data } = await supabase
    .from('partners')
    .select('id')
    .ilike('name', `%${search}%`);
  return (data || []).map(p => p.id);
}

async function applyFilters(q) {
  const f = state.filters;
  if (f.search) {
    const partnerIds = await findPartnerIdsBySearch(f.search);
    if (partnerIds.length > 0) {
      q = q.or(`invoice_no.ilike.%${f.search}%,partner_id.in.(${partnerIds.join(',')})`);
    } else {
      q = q.ilike('invoice_no', `%${f.search}%`);
    }
  }
  if (f.partner_id) q = q.eq('partner_id', f.partner_id);
  if (f.status) q = q.eq('status', f.status);
  if (f.currency) q = q.eq('currency', f.currency);
  if (f.from) q = q.gte('dev_date', f.from);
  if (f.to) q = q.lte('dev_date', f.to);
  return q;
}

// ============================================================
// TAB SWITCHER
// ============================================================
function bindTabs() {
  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTab = btn.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      document.getElementById('tab-' + state.activeTab).style.display = 'block';

      if (state.activeTab === 'invoice' && state.canViewInvoice) {
        await loadInvoices();
      } else if (state.activeTab === 'aging' && state.canViewAging) {
        await loadAging();
      } else if (state.activeTab === 'payment' && state.canViewInvoice) {
        if (!state.paymentsLoaded) {
          await loadPaymentInvoices();
          state.paymentsLoaded = true;
        }
        await loadPayments();
      } else if (state.activeTab === 'plan' && state.canViewPlan) {
        await loadPlans();
      } else if (state.activeTab === 'clearing' && state.canManage) {
        wireClearingForm();
        if (!state.clearingLoaded) {
          await loadClearingHistory();
          state.clearingLoaded = true;
        }
      }
    });
  });
}

// ============================================================
// FILTER OPTIONS
// ============================================================
async function loadFilterOptions() {
  const { data: vendors } = await supabase
    .from('partners')
    .select('id, name, type')
    .in('type', ['vendor', 'both'])
    .order('name');
  const selP = document.getElementById('fPartner');
  (vendors || []).forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    selP.appendChild(opt);
  });
}

// ============================================================
// QUERY — LIST INVOICE
// ============================================================
async function loadInvoices() {
  const tbody = document.getElementById('tbody-invoices');
  tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#9ca3af;padding:16px;">Memuat...</td></tr>';

  const from = (state.page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let q = supabase
    .from('purchase_invoices')
    .select(`
      id, invoice_no, dev_date, due_date, currency, exchange_rate,
      subtotal, ppn_amount_idr, total_idr, total_usd, status,
      partner:partners!inner(id, name)
    `, { count: 'exact' })
    .order('dev_date', { ascending: false })
    .order('invoice_no', { ascending: false })
    .range(from, to);

  q = await applyFilters(q);

  const { data, error, count } = await q;
  if (error) {
    console.error(error);
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#dc2626;padding:16px;">Error: ${esc(error.message)}</td></tr>`;
    return;
  }
  state.total = count || 0;
  renderTable(data || []);
  renderPagination();
  await loadSummary();
}

function renderTable(rows) {
  const tbody = document.getElementById('tbody-invoices');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#9ca3af;padding:16px;">Tidak ada invoice.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr data-id="${r.id}" style="cursor:pointer;">
      <td data-label="Invoice No" style="font-family:monospace;font-size:12px;">${esc(r.invoice_no)}</td>
      <td data-label="Vendor">${esc(r.partner?.name || '—')}</td>
      <td data-label="Dev Date">${fmtDate(r.dev_date)}</td>
      <td data-label="Due Date">${fmtDate(r.due_date)}</td>
      <td data-label="Curr">${esc(r.currency)}</td>
      <td data-label="Subtotal" class="num">${fmt(r.subtotal)}</td>
      <td data-label="PPN (IDR)" class="num">${fmt(r.ppn_amount_idr)}</td>
      <td data-label="Total IDR" class="num" style="font-weight:600;">${fmt(r.total_idr)}</td>
      <td data-label="Status">${statusBadge(r.status)}</td>
    </tr>
  `).join('');
  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', () => openDetail(tr.dataset.id));
  });
}

// ============================================================
// SUMMARY
// ============================================================
async function loadSummary() {
  let q = supabase
    .from('purchase_invoices')
    .select('subtotal, ppn_amount_idr, total_idr, total_usd, currency', { count: 'exact' });

  q = await applyFilters(q);

  const { data, error } = await q;
  if (error) { console.warn(error); return; }

  let subIdr = 0, subUsd = 0, ppn = 0, totalIdr = 0, totalUsd = 0;
  (data || []).forEach(r => {
    if (r.currency === 'USD') { subUsd += Number(r.subtotal || 0); totalUsd += Number(r.total_usd || 0); }
    else subIdr += Number(r.subtotal || 0);
    ppn += Number(r.ppn_amount_idr || 0);
    totalIdr += Number(r.total_idr || 0);
  });

  document.getElementById('sumInvoices').textContent = fmtInt(state.total);
  document.getElementById('sumLines').textContent = fmtInt(data?.length || 0);
  document.getElementById('sumSubtotal').textContent =
    'IDR ' + fmt(subIdr) + (subUsd ? ' + USD ' + fmt(subUsd) : '');
  document.getElementById('sumPpn').textContent = 'IDR ' + fmt(ppn);
  document.getElementById('sumTotalIdr').textContent = 'IDR ' + fmt(totalIdr);
  document.getElementById('sumTotalUsd').textContent = 'USD ' + fmt(totalUsd);
}

// ============================================================
// PAGINATION
// ============================================================
function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
  const info = document.getElementById('paginationInfo');
  const from = state.total ? (state.page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(state.page * PAGE_SIZE, state.total);
  info.textContent = `Menampilkan ${from}–${to} dari ${state.total} invoice`;

  const wrap = document.getElementById('pagination');
  if (totalPages <= 1) { wrap.innerHTML = ''; return; }

  const btn = (label, page, disabled, active) => {
    const style = active
      ? 'padding:6px 12px;border-radius:6px;border:1px solid #0891b2;background:#0891b2;color:#fff;font-size:12px;cursor:pointer;'
      : 'padding:6px 12px;border-radius:6px;border:1px solid #d0d5dd;background:#fff;font-size:12px;cursor:pointer;';
    return `<button data-page="${page}" ${disabled ? 'disabled' : ''} style="${style}${disabled ? 'opacity:.5;cursor:not-allowed;' : ''}">${label}</button>`;
  };

  let html = '';
  html += btn('« Prev', state.page - 1, state.page <= 1, false);
  const start = Math.max(1, state.page - 3);
  const end = Math.min(totalPages, state.page + 3);
  for (let i = start; i <= end; i++) html += btn(String(i), i, false, i === state.page);
  if (end < totalPages) html += `<span style="padding:6px 4px;color:#6b7280;">…</span>`;
  html += btn('Next »', state.page + 1, state.page >= totalPages, false);

  wrap.innerHTML = html;
  wrap.querySelectorAll('button[data-page]').forEach(b => {
    b.addEventListener('click', () => {
      const p = Number(b.dataset.page);
      if (p >= 1 && p <= totalPages && p !== state.page) {
        state.page = p;
        loadInvoices();
      }
    });
  });
}

// ============================================================
// DETAIL MODAL
// ============================================================
async function openDetail(invoiceId) {
  const modal = document.getElementById('detailModal');
  const headerEl = document.getElementById('detailHeader');
  const linesEl = document.getElementById('detailLines');
  modal.style.display = 'flex';
  headerEl.innerHTML = '<div style="color:#9ca3af;">Memuat...</div>';
  linesEl.innerHTML = '';

  const { data: inv, error: e1 } = await supabase
    .from('purchase_invoices')
    .select(`*, partner:partners!inner(id, name)`)
    .eq('id', invoiceId)
    .single();

  if (e1) {
    headerEl.innerHTML = `<div style="color:#dc2626;">Error: ${esc(e1.message)}</div>`;
    return;
  }

  document.getElementById('detailTitle').textContent = `Invoice ${inv.invoice_no}`;
  headerEl.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;background:#f9fafb;padding:12px;border-radius:8px;">
      <div><div style="font-size:11px;color:#6b7280;">Vendor</div><div style="font-weight:600;">${esc(inv.partner?.name || '—')}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Dev Date</div><div>${fmtDate(inv.dev_date)}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Due Date</div><div>${fmtDate(inv.due_date)}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Terms</div><div>${inv.terms_days_actual} hari</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Currency</div><div>${esc(inv.currency)}${inv.exchange_rate ? ' @ ' + fmt(inv.exchange_rate) : ''}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Status</div><div>${statusBadge(inv.status)}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Subtotal</div><div style="font-weight:600;">${fmt(inv.subtotal)}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">PPN (IDR)</div><div>${fmt(inv.ppn_amount_idr)}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Total IDR</div><div style="font-weight:600;color:#dc2626;">${fmt(inv.total_idr)}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Total USD</div><div>${fmt(inv.total_usd)}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Clearing Cost (IDR)</div><div>${fmt(inv.clearing_cost_idr)}</div></div>
      ${inv.customs_note ? `<div style="grid-column:span 2;"><div style="font-size:11px;color:#6b7280;">Customs Note</div><div>${esc(inv.customs_note)}</div></div>` : ''}
    </div>
  `;

  const { data: lines, error: e2 } = await supabase
    .from('purchase_invoice_lines')
    .select(`*, item:items!inner(sku, name, nama_beli)`)
    .eq('invoice_id', invoiceId)
    .order('line_no');

  if (e2) {
    linesEl.innerHTML = `<tr><td colspan="9" style="color:#dc2626;">Error: ${esc(e2.message)}</td></tr>`;
    return;
  }
  if (!lines || !lines.length) {
    linesEl.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#9ca3af;padding:8px;">Tidak ada line.</td></tr>';
  } else {
    linesEl.innerHTML = lines.map(l => `
      <tr>
        <td data-label="Line">${l.line_no}</td>
        <td data-label="SKU" style="font-family:monospace;font-size:12px;">${esc(l.item?.sku || '—')}</td>
        <td data-label="Nama">${esc(l.display_name || l.item?.name || '—')}</td>
        <td data-label="Qty" class="num">${fmtInt(l.qty)}</td>
        <td data-label="Satuan">${esc(l.qty_unit)}</td>
        <td data-label="Harga" class="num">${fmt(l.unit_price)}</td>
        <td data-label="Total" class="num">${fmt(l.line_total)}</td>
        <td data-label="PPN (IDR)" class="num">${fmt(l.ppn_amount_idr)}</td>
        <td data-label="Remark" style="font-size:12px;color:#6b7280;">${esc(l.remark || '')}</td>
      </tr>
    `).join('');
  }
}

function closeDetail() {
  document.getElementById('detailModal').style.display = 'none';
}

// ============================================================
// BANK ACCOUNTS (via RPC)
// ============================================================
async function loadBankAccounts() {
  const { data, error } = await supabase.rpc('list_bank_accounts');
  if (error) { console.error('list_bank_accounts:', error); return; }
  state.bankAccounts = data || [];

  const sel = document.getElementById('pBankCode');
  if (!sel) return;
  sel.innerHTML = '<option value="">— pilih rekening —</option>' +
    state.bankAccounts.map(a =>
      `<option value="${esc(a.account_code)}">${esc(a.account_code)} — ${esc(a.account_name)}</option>`
    ).join('');
}

// ============================================================
// TAB PEMBAYARAN — LOAD INVOICE CACHE
// ============================================================
async function loadPaymentInvoices() {
  const { data: invs, error } = await supabase
    .from('purchase_invoices')
    .select(`id, invoice_no, currency, total_idr, total_usd, status, partner:partners!inner(name)`)
    .in('status', ['posted', 'partial'])
    .order('invoice_no', { ascending: true });

  if (error) { console.error('loadPaymentInvoices:', error); return; }

  const { data: pays, error: e2 } = await supabase
    .from('purchase_payment_allocations')
    .select('invoice_id, amount, purchase_payments!inner(deleted_at)')
    .is('purchase_payments.deleted_at', null);
  if (e2) { console.error('loadPaymentInvoices/alloc:', e2); }

  const paidMap = {};
  (pays || []).forEach(p => {
    paidMap[p.invoice_id] = (paidMap[p.invoice_id] || 0) + Number(p.amount || 0);
  });

  state.payInvoicesCache = (invs || []).map(i => {
    const paid = paidMap[i.id] || 0;
    const total = i.currency === 'USD' ? Number(i.total_usd || 0) : Number(i.total_idr || 0);
    return {
      ...i,
      paid_amount: paid,
      sisa: Math.max(0, total - paid)
    };
  });
}

// ============================================================
// TAB PEMBAYARAN — FORM
// ============================================================
function bindPaymentTab() {
  document.getElementById('pDate').value = new Date().toISOString().slice(0, 10);

  const curSel = document.getElementById('pCurrency');
  const fxWrap = document.getElementById('pFxWrap');
  const rateInput = document.getElementById('pFxRate');

  function toggleFx() {
    const isUsd = curSel.value === 'USD';
    fxWrap.style.display = isUsd ? '' : 'none';
    document.getElementById('payTotalCur').textContent = curSel.value;
    state.payRateTouched = false;
    if (!isUsd) {
      rateInput.value = '';
      state.bookRate = null;
      hideFxHint();
    } else {
      refreshFxBookRate();
    }
    resetPayAlloc();
    updatePaymentTotal();
  }
  curSel.addEventListener('change', toggleFx);
  toggleFx();

  // Ganti rekening sumber -> kurs buku dihitung ulang untuk akun tersebut
  document.getElementById('pBankCode').addEventListener('change', () => {
    state.payRateTouched = false;
    refreshFxBookRate();
  });
  // Tanggal bayar berubah -> kurs buku dihitung s.d. tanggal tersebut
  document.getElementById('pDate').addEventListener('change', () => {
    if (!state.payRateTouched) refreshFxBookRate();
  });
  // Kurs diubah manual -> jangan ditimpa auto-fill lagi
  rateInput.addEventListener('input', () => {
    state.payRateTouched = true;
    updatePaymentTotal();
  });

  document.getElementById('pAddAllocBtn').addEventListener('click', () => addPayAllocRow());
  document.getElementById('pResetBtn').addEventListener('click', () => {
    document.getElementById('pNote').value = '';
    rateInput.value = '';
    document.getElementById('pDate').value = new Date().toISOString().slice(0, 10);
    state.payRateTouched = false;
    resetPayAlloc();
    updatePaymentTotal();
    refreshFxBookRate();
  });
  document.getElementById('pSaveBtn').addEventListener('click', submitPayment);
  document.getElementById('payRefreshBtn').addEventListener('click', () => loadPayments());

  let timer;
  document.getElementById('paySearch').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.payFilters.search = document.getElementById('paySearch').value;
      loadPayments();
    }, 350);
  });
  document.getElementById('payFrom').addEventListener('change', () => {
    state.payFilters.from = document.getElementById('payFrom').value;
    loadPayments();
  });
  document.getElementById('payTo').addEventListener('change', () => {
    state.payFilters.to = document.getElementById('payTo').value;
    loadPayments();
  });

  const formCard = document.getElementById('paymentFormCard');
  formCard.style.display = state.canCreatePayment ? 'block' : 'none';
}

// ------------------------------------------------------------
// Kurs buku USD: auto-fill dari rata-rata kurs buku stok USD
// di rekening sumber (akun COA yang dipilih), bisa diubah manual.
// ------------------------------------------------------------
function hideFxHint() {
  const el = document.getElementById('pFxHint');
  if (!el) return;
  el.style.display = 'none';
  el.textContent = '';
}

function showFxHint(text, warn = false) {
  const el = document.getElementById('pFxHint');
  if (!el) return;
  el.textContent = text || '';
  el.style.display = text ? 'block' : 'none';
  el.style.color = warn ? '#92400e' : '#6b7280';
}

async function refreshFxBookRate() {
  const currency = document.getElementById('pCurrency').value;
  const bankCode = document.getElementById('pBankCode').value;
  const rateInput = document.getElementById('pFxRate');

  if (currency !== 'USD') {
    state.bookRate = null;
    hideFxHint();
    return;
  }
  if (!bankCode) {
    state.bookRate = null;
    showFxHint('Pilih rekening sumber dulu — kurs buku USD akan terisi otomatis dari akun tersebut.', true);
    return;
  }

  const token = ++state.bookRateReq;
  showFxHint('Menghitung kurs buku rata-rata…');
  try {
    const r = await getValasBookRate(
      bankCode, currency, document.getElementById('pDate').value || null
    );
    if (token !== state.bookRateReq) return;
    state.bookRate = r;

    if (!r.rate) {
      state.bookRate = null;
      showFxHint(
        `Kurs buku ${r.code} belum bisa dihitung: saldo ${r.currency} di akun ini 0. ` +
        `Isi kurs buku manual.`, true
      );
      return;
    }

    if (!state.payRateTouched) rateInput.value = r.rate.toFixed(4);
    const minus = r.saldo_valas < 0 ? ' (saldo minus)' : '';
    showFxHint(
      `Kurs buku rata-rata ${r.code} ${r.name}: ${fmt(r.rate)} · ` +
      `saldo ${fmt(r.saldo_valas)} ${r.currency} = Rp ${fmt(r.saldo_idr)}${minus}. ` +
      `Boleh diubah manual bila perlu.`
    );
  } catch (e) {
    if (token !== state.bookRateReq) return;
    console.error('getValasBookRate:', e);
    showFxHint('Gagal menghitung kurs buku: ' + (e.message || e) + ' — isi kurs manual.', true);
  } finally {
    if (token === state.bookRateReq) updatePaymentTotal();
  }
}

function resetPayAlloc() {
  const tbody = document.getElementById('tbody-pay-alloc');
  tbody.innerHTML = `
    <tr class="pay-alloc-placeholder">
      <td colspan="4" style="text-align:center;color:#9ca3af;padding:8px;">
        Belum ada alokasi. Klik "+ Tambah Invoice".
      </td>
    </tr>`;
  state.payAllocCount = 0;
}

function addPayAllocRow() {
  state.payAllocCount++;
  const currency = document.getElementById('pCurrency').value;
  const tbody = document.getElementById('tbody-pay-alloc');
  const ph = tbody.querySelector('.pay-alloc-placeholder');
  if (ph) ph.remove();

  const candidates = (state.payInvoicesCache || []).filter(i =>
    i.currency === currency && i.sisa > 0.01
  );

  if (!candidates.length) {
    toast(`Tidak ada invoice ${currency} dengan sisa hutang`, true);
    return;
  }

  const tr = document.createElement('tr');
  tr.dataset.allocId = state.payAllocCount;
  tr.innerHTML = `
    <td data-label="Invoice">
      <select class="pay-alloc-invoice" required style="width:100%;padding:6px;border:1px solid #d0d5dd;border-radius:6px;">
        <option value="">— pilih invoice —</option>
        ${candidates.map(i =>
          `<option value="${i.id}" data-sisa="${i.sisa}">${esc(i.invoice_no)} — ${esc(i.partner?.name || '')} (sisa ${fmt(i.sisa)})</option>`
        ).join('')}
      </select>
    </td>
    <td data-label="Sisa Hutang" class="num pay-alloc-sisa" style="color:#6b7280;">—</td>
    <td data-label="Jumlah Bayar" class="num">
      <input type="number" class="pay-alloc-amount" step="0.01" min="0.01" required
             style="width:100%;padding:6px;border:1px solid #d0d5dd;border-radius:6px;text-align:right;">
    </td>
    <td>
      <button type="button" class="pay-alloc-remove" title="Hapus"
              style="background:#fee2e2;color:#991b1b;border:none;border-radius:5px;width:26px;height:26px;font-size:14px;cursor:pointer;font-weight:700;">×</button>
    </td>
  `;
  tbody.appendChild(tr);

  tr.querySelector('.pay-alloc-invoice').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    const sisa = opt ? Number(opt.dataset.sisa || 0) : 0;
    tr.querySelector('.pay-alloc-sisa').textContent = sisa ? fmt(sisa) : '—';
    const amtInput = tr.querySelector('.pay-alloc-amount');
    if (sisa > 0 && !amtInput.value) {
      amtInput.value = sisa.toFixed(2);
    }
    updatePaymentTotal();
  });

  tr.querySelector('.pay-alloc-amount').addEventListener('input', updatePaymentTotal);

  tr.querySelector('.pay-alloc-remove').addEventListener('click', () => {
    tr.remove();
    if (!document.querySelectorAll('#tbody-pay-alloc tr[data-alloc-id]').length) {
      resetPayAlloc();
    }
    updatePaymentTotal();
  });

  updatePaymentTotal();
}

function updatePaymentTotal() {
  const currency = document.getElementById('pCurrency').value;
  const fx = Number(document.getElementById('pFxRate').value) || 0;

  let total = 0;
  document.querySelectorAll('#tbody-pay-alloc .pay-alloc-amount').forEach(inp => {
    total += Number(inp.value) || 0;
  });

  document.getElementById('payTotalCur').textContent = currency;
  document.getElementById('payTotalAmount').textContent = fmt(total);

  if (currency === 'USD') {
    document.getElementById('payTotalIdr').textContent = fx > 0 ? fmt(total * fx) : '— (isi kurs buku)';
  } else {
    document.getElementById('payTotalIdr').textContent = fmt(total);
  }
}

function collectPaymentAllocs() {
  const rows = document.querySelectorAll('#tbody-pay-alloc tr[data-alloc-id]');
  const allocs = [];
  for (const tr of rows) {
    const invId = Number(tr.querySelector('.pay-alloc-invoice').value);
    const amount = Number(tr.querySelector('.pay-alloc-amount').value);
    if (!invId) { toast('Semua baris alokasi harus pilih invoice', true); return null; }
    if (!amount || amount <= 0) { toast('Jumlah bayar harus > 0', true); return null; }
    allocs.push({ invoice_id: invId, amount });
  }
  if (!allocs.length) { toast('Minimal 1 alokasi invoice', true); return null; }

  const map = {};
  (state.payInvoicesCache || []).forEach(i => { map[i.id] = i.invoice_no; });
  return allocs.map(a => ({ invoice_no: map[a.invoice_id], amount: a.amount }));
}

async function submitPayment() {
  if (!state.canCreatePayment) { toast('Tidak ada akses', true); return; }

  const dateEl = document.getElementById('pDate');
  const currency = document.getElementById('pCurrency').value;
  const bankCode = document.getElementById('pBankCode').value;
  const fx = Number(document.getElementById('pFxRate').value) || 0;
  const note = document.getElementById('pNote').value.trim() || null;

  if (!dateEl.value) { toast('Tanggal wajib diisi', true); return; }
  if (!bankCode) { toast('Rekening sumber wajib dipilih', true); return; }
  if (currency === 'USD' && (!fx || fx <= 0)) { toast('Kurs buku USD wajib diisi (> 0)', true); return; }

  const allocs = collectPaymentAllocs();
  if (allocs === null) return;

  const total = allocs.reduce((s, a) => s + a.amount, 0);
  const confirmMsg = `Simpan pembayaran ${currency} ${fmt(total)}` +
    (currency === 'USD' ? ` @ kurs buku ${fmt(fx)} (≈ Rp ${fmt(total * fx)})` : '') +
    ` ke ${allocs.length} invoice?\n\nJurnal otomatis akan dibuat.`;
  if (!confirm(confirmMsg)) return;

  const btn = document.getElementById('pSaveBtn');
  btn.disabled = true; btn.textContent = 'Memproses...';

  try {
    const payload = {
      payment_date: dateEl.value,
      currency,
      bank_coa_code: bankCode,
      note,
      exchange_rate_buy: currency === 'USD' ? fx : 1,
      allocations: allocs
    };
    const { data, error } = await supabase.rpc('add_purchase_payment', { p_payload: payload });
    if (error) throw error;

    const r = data || {};
    toast(`✓ Pembayaran ${r.payment_no || ''} tersimpan` +
      (r.selisih_kurs_idr ? ` · selisih kurs ${fmt(r.selisih_kurs_idr)}` : ''));

    document.getElementById('pResetBtn').click();
    await loadPaymentInvoices();
    await loadPayments();
  } catch (err) {
    toast('Gagal: ' + (err.message || err), true);
  } finally {
    btn.disabled = false; btn.textContent = 'Simpan Pembayaran';
  }
}

// ============================================================
// TAB PEMBAYARAN — RIWAYAT
// ============================================================
async function loadPayments() {
  const tbody = document.getElementById('tbody-payments');
  tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#9ca3af;padding:16px;">Memuat...</td></tr>';

  let q = supabase
    .from('purchase_payments')
    .select(`
      id, payment_no, payment_date, currency, bank_coa_code,
      total_amount, exchange_rate_buy, note, journal_id, created_at,
      allocations:purchase_payment_allocations(
        amount, amount_idr, selisih_kurs_idr,
        invoice:purchase_invoices(id, invoice_no)
      )
    `)
    .is('deleted_at', null)
    .order('payment_date', { ascending: false })
    .order('id', { ascending: false });

  const f = state.payFilters;
  if (f.from) q = q.gte('payment_date', f.from);
  if (f.to) q = q.lte('payment_date', f.to);

  const { data, error } = await q;
  if (error) {
    tbody.innerHTML = `<tr><td colspan="10" style="color:#dc2626;">${esc(error.message)}</td></tr>`;
    return;
  }

  let rows = data || [];
  if (f.search) {
    const s = f.search.toLowerCase();
    rows = rows.filter(r => {
      if ((r.payment_no || '').toLowerCase().includes(s)) return true;
      return (r.allocations || []).some(a =>
        (a.invoice?.invoice_no || '').toLowerCase().includes(s)
      );
    });
  }

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#9ca3af;">Belum ada pembayaran.</td></tr>';
    document.getElementById('payTotalInfo').textContent = '';
    return;
  }

  let totalIdr = 0, totalSelisih = 0;
  tbody.innerHTML = rows.map(r => {
    const invNos = (r.allocations || []).map(a => a.invoice?.invoice_no).filter(Boolean);
    const totalIdrRow = (r.allocations || []).reduce((s, a) => s + Number(a.amount_idr || 0), 0);
    const selisihRow = (r.allocations || []).reduce((s, a) => s + Number(a.selisih_kurs_idr || 0), 0);
    totalIdr += totalIdrRow;
    totalSelisih += selisihRow;

    const selisihColor = selisihRow > 0 ? '#dc2626' : (selisihRow < 0 ? '#059669' : '#6b7280');
    const selisihLabel = selisihRow > 0 ? `Rugi ${fmt(selisihRow)}` :
                          selisihRow < 0 ? `Laba ${fmt(-selisihRow)}` : '—';

    return `
      <tr>
        <td data-label="Payment No" style="font-family:monospace;font-size:12px;">${esc(r.payment_no)}</td>
        <td data-label="Tanggal">${fmtDate(r.payment_date)}</td>
        <td data-label="Curr">${esc(r.currency)}</td>
        <td data-label="Bank" style="font-size:12px;">${esc(r.bank_coa_code)}</td>
        <td data-label="Total" class="num">${fmt(r.total_amount)}</td>
        <td data-label="Total IDR" class="num">${fmt(totalIdrRow)}</td>
        <td data-label="Selisih Kurs" class="num" style="color:${selisihColor};">${selisihLabel}</td>
        <td data-label="Invoice" style="font-size:12px;">${invNos.length ? invNos.map(esc).join(', ') : '—'}</td>
        <td data-label="Catatan" style="font-size:12px;color:#6b7280;">${esc(r.note || '')}</td>
        <td data-label="Aksi">
          ${state.canDeletePayment
            ? `<button class="btn-del-pay" data-id="${r.id}" data-no="${esc(r.payment_no)}"
                       style="background:#fee2e2;color:#991b1b;border:none;border-radius:5px;padding:4px 8px;font-size:12px;cursor:pointer;">
                 Hapus
               </button>`
            : '—'}
        </td>
      </tr>`;
  }).join('');

  document.getElementById('payTotalInfo').textContent =
    `Total IDR dibayar: Rp ${fmt(totalIdr)} · Selisih kurs net: ${fmt(totalSelisih)}`;

  tbody.querySelectorAll('.btn-del-pay').forEach(btn => {
    btn.addEventListener('click', () => deletePayment(btn.dataset.id, btn.dataset.no));
  });
}

async function deletePayment(paymentId, paymentNo) {
  if (!state.canDeletePayment) { toast('Tidak ada akses hapus', true); return; }
  if (!confirm(`Hapus pembayaran ${paymentNo}?\n\nJurnal reversal akan dibuat otomatis, status invoice dikembalikan.`)) return;

  try {
    const { data, error } = await supabase.rpc('delete_purchase_payment', { p_payment_id: Number(paymentId) });
    if (error) throw error;
    toast(`✓ ${paymentNo} dihapus (reversal journal #${data?.reversal_journal_id || '-'})`);
    await loadPaymentInvoices();
    await loadPayments();
    if (state.activeTab === 'invoice') await loadInvoices();
  } catch (err) {
    toast('Gagal hapus: ' + (err.message || err), true);
  }
}

// ============================================================
// TAB RENCANA BAYAR (antrian prioritas hutang)
// ============================================================
// Grand Total kumulatif PER CURRENCY: total rencana bayar dengan
// plan_date <= tanggal baris ini. Baris bertanggal sama dihitung
// berurutan mengikuti sort_order (urutan antrian).
// Urutan tampil antrian = TANGGAL RENCANA (terdekat di atas), lalu sort_order
// (prioritas manual antar invoice bertanggal SAMA), lalu id sebagai penentu
// terakhir. Konsekuensi: begitu tanggal diubah, baris langsung pindah posisi.
function sortPlansForDisplay(plans) {
  return [...(plans || [])].sort((a, b) => {
    const da = a.plan_date || '';
    const db = b.plan_date || '';
    if (da !== db) return da < db ? -1 : 1;
    const sa = Number(a.sort_order) || 0;
    const sb = Number(b.sort_order) || 0;
    if (sa !== sb) return sa - sb;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });
}

function planGrandTotals(plans) {
  const sorted = sortPlansForDisplay(plans);
  const cum = { IDR: 0, USD: 0 };
  const map = {};
  sorted.forEach(p => {
    const cur = p.currency === 'USD' ? 'USD' : 'IDR';
    cum[cur] += Number(p.plan_amount) || 0;
    map[p.id] = { IDR: cum.IDR, USD: cum.USD };
  });
  return map;
}

function renderPlans() {
  const tbody = document.getElementById('tbody-plans');
  const tfoot = document.getElementById('tfoot-plans');
  if (!tbody) return;

  const plans = state.plans || [];

  if (!plans.length) {
    tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;color:#9ca3af;padding:16px;">Belum ada invoice di antrian rencana bayar.</td></tr>';
    if (tfoot) tfoot.innerHTML = '';
    return;
  }

  const grand = planGrandTotals(plans);
  const totals = { IDR: 0, USD: 0 };
  plans.forEach(p => {
    totals[p.currency === 'USD' ? 'USD' : 'IDR'] += Number(p.plan_amount) || 0;
  });

  const canEdit = state.canManagePlan;
  const lastIdx = plans.length - 1;
  const sameDate = (x, y) => ((x?.plan_date || '') === (y?.plan_date || ''));

  tbody.innerHTML = plans.map((p, idx) => {
    const upAllowed = idx > 0 && sameDate(p, plans[idx - 1]);
    const downAllowed = idx < lastIdx && sameDate(p, plans[idx + 1]);
    const cur = p.currency === 'USD' ? 'USD' : 'IDR';
    const g = grand[p.id] || { IDR: 0, USD: 0 };
    const gVal = cur === 'USD' ? g.USD : g.IDR;
    const inv = p.invoice || {};
    const partner = inv.partner || {};
    const amountValue = String(Number(p.plan_amount || 0));

    return `
      <tr data-plan-row="${p.id}">
        <td data-label="No" class="plan-seq">
          <span class="plan-num">${idx + 1}</span>
          ${canEdit ? `
            <span class="plan-move">
              <button type="button" class="plan-move-btn" data-move="${p.id}" data-dir="up"
                      title="${upAllowed ? 'Naikkan prioritas (tanggal sama)' : 'Tidak ada invoice bertanggal sama di atasnya'}"
                      ${upAllowed ? '' : 'disabled'}>▲</button>
              <button type="button" class="plan-move-btn" data-move="${p.id}" data-dir="down"
                      title="${downAllowed ? 'Turunkan prioritas (tanggal sama)' : 'Tidak ada invoice bertanggal sama di bawahnya'}"
                      ${downAllowed ? '' : 'disabled'}>▼</button>
            </span>` : ''}
        </td>
        <td data-label="Invoice" style="font-family:monospace;font-size:12px;">${esc(inv.invoice_no || '—')}</td>
        <td data-label="Vendor">${esc(partner.name || '—')}</td>
        <td data-label="Curr">${esc(cur)}</td>
        <td data-label="Jatuh Tempo">${fmtDate(inv.due_date)}</td>
        <td data-label="Subtotal" class="num">${fmt(inv.subtotal)}</td>
        <td data-label="Sudah Bayar" class="num" style="color:#6b7280;">${fmt(p.paid_amount)}</td>
        <td data-label="Sisa" class="num" style="color:#b45309;font-weight:600;">${fmt(p.sisa)}</td>
        <td data-label="Tgl Rencana">
          ${canEdit
            ? `<input type="date" class="input plan-date-input" data-plan-id="${p.id}" value="${esc(p.plan_date || '')}">`
            : fmtDate(p.plan_date)}
        </td>
        <td data-label="Rencana Bayar" class="num">
          ${canEdit
            ? `<input type="text" class="input plan-amount-input" data-plan-id="${p.id}"
                      inputmode="decimal" value="${amountValue}">`
            : fmt(p.plan_amount)}
        </td>
        <td data-label="Grand Total" class="num plan-grand"
            title="Kumulatif s/d tanggal ini — IDR: ${fmt(g.IDR)} · USD: ${fmt(g.USD)}">${fmt(gVal)}</td>
        <td data-label="Catatan" style="font-size:12px;color:#6b7280;">${esc(p.note || '')}</td>
        <td data-label="Aksi">
          ${canEdit
            ? `<button type="button" class="btn-plan-del" data-plan-del="${p.id}"
                       title="Keluarkan dari antrian">Hapus</button>`
            : '—'}
        </td>
      </tr>`;
  }).join('');

  if (tfoot) {
    const parts = [];
    if (totals.IDR) parts.push('IDR ' + fmt(totals.IDR));
    if (totals.USD) parts.push('USD ' + fmt(totals.USD));
    tfoot.innerHTML = `
      <tr style="background:#f9fafb;">
        <td colspan="9" style="text-align:right;font-weight:600;">Total rencana bayar</td>
        <td colspan="2" class="num" style="font-weight:700;">${parts.join(' · ') || '—'}</td>
        <td colspan="2"></td>
      </tr>`;
  }

  tbody.querySelectorAll('[data-move]').forEach(btn => {
    btn.addEventListener('click', () => movePlan(Number(btn.dataset.move), btn.dataset.dir));
  });
  tbody.querySelectorAll('[data-plan-del]').forEach(btn => {
    btn.addEventListener('click', () => deletePlan(Number(btn.dataset.planDel)));
  });
  tbody.querySelectorAll('.plan-date-input').forEach(inp => {
    inp.addEventListener('change', () => savePlanInline(Number(inp.dataset.planId)));
  });
  tbody.querySelectorAll('.plan-amount-input').forEach(inp => {
    inp.addEventListener('change', () => savePlanInline(Number(inp.dataset.planId)));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    });
  });
}

async function loadPlans() {
  const tbody = document.getElementById('tbody-plans');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;color:#9ca3af;padding:16px;">Memuat...</td></tr>';

  try {
    state.plans = sortPlansForDisplay(await listPaymentPlans());
    state.plansLoaded = true;
    renderPlans();
    try {
      await fillPlanInvoiceOptions();
    } catch (optErr) {
      console.warn('opsi invoice rencana bayar:', optErr);
    }
  } catch (err) {
    console.error('loadPlans:', err);
    tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;color:#dc2626;padding:16px;">Error: ${esc(err.message || err)}</td></tr>`;
    const tfoot = document.getElementById('tfoot-plans');
    if (tfoot) tfoot.innerHTML = '';
  }
}

// Dropdown invoice: hanya invoice bersisa > 0 yang BELUM ada di antrian.
async function fillPlanInvoiceOptions() {
  const sel = document.getElementById('plInvoice');
  if (!sel) return;

  if (!(state.payInvoicesCache || []).length) {
    await loadPaymentInvoices();
  }
  renderPlanInvoiceOptions();
}

// Filter pencarian: setiap kata yang diketik harus cocok dengan nomor invoice
// ATAU nama vendor (tidak peka huruf besar/kecil).
function planInvoiceMatches(inv, q) {
  if (!q) return true;
  const hay = `${inv.invoice_no || ''} ${inv.partner?.name || ''}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every(tok => hay.includes(tok));
}

// Render ulang opsi dropdown sesuai kotak pencarian (tanpa query ulang ke DB).
function renderPlanInvoiceOptions() {
  const sel = document.getElementById('plInvoice');
  if (!sel) return;

  const q = (state.planInvoiceSearch || '').trim().toLowerCase();
  const qRaw = (state.planInvoiceSearch || '').trim();
  const queued = new Set((state.plans || []).map(p => Number(p.invoice_id)));
  const available = (state.payInvoicesCache || []).filter(i =>
    Number(i.sisa) > 0.01 && !queued.has(Number(i.id))
  );
  const matches = available.filter(i => planInvoiceMatches(i, q));

  const prev = sel.value;
  const prevItem = prev ? available.find(i => String(i.id) === prev) : null;
  // Invoice yang sudah terpilih tetap ditampilkan walau tidak cocok pencarian,
  // supaya mengetik di kotak cari tidak menghapus pilihan secara diam-diam.
  const list = (prevItem && !matches.includes(prevItem)) ? [prevItem, ...matches] : matches;

  sel.innerHTML = '<option value="">— pilih invoice —</option>' + list.map(i =>
    `<option value="${i.id}" data-curr="${esc(i.currency || 'IDR')}" data-sisa="${Number(i.sisa) || 0}">` +
    `${esc(i.invoice_no)} — ${esc(i.partner?.name || '')} — sisa ${esc(i.currency || 'IDR')} ${fmt(i.sisa)}</option>`
  ).join('');

  sel.value = prevItem ? prev : '';

  const countEl = document.getElementById('plInvCount');
  if (countEl) {
    if (!available.length) {
      countEl.textContent = 'Tidak ada invoice bersisa yang belum masuk antrian.';
    } else if (q) {
      countEl.textContent = matches.length
        ? `${matches.length} dari ${available.length} invoice cocok dengan "${qRaw}".`
        : `Tidak ada invoice cocok dengan "${qRaw}".`;
    } else {
      countEl.textContent = `${available.length} invoice siap dipilih — ketik nomor invoice / vendor untuk memfilter.`;
    }
  }

  onPlanInvoiceChange();
}

function onPlanInvoiceChange() {
  const sel = document.getElementById('plInvoice');
  const hint = document.getElementById('plInvoiceHint');
  const curLabel = document.getElementById('plCurLabel');
  const amountEl = document.getElementById('plAmount');
  if (!sel) return;

  const opt = (sel.selectedOptions && sel.selectedOptions[0]) || null;
  const cur = opt?.dataset?.curr || '';
  const sisa = Number(opt?.dataset?.sisa || 0);

  if (curLabel) curLabel.textContent = cur || 'IDR';
  if (opt && opt.value) {
    if (hint) hint.textContent = `Sisa hutang ${cur} ${fmt(sisa)} — nominal boleh parsial.`;
    if (amountEl) amountEl.placeholder = `maks ${fmt(sisa)}`;
  } else {
    if (hint) hint.textContent = '';
    if (amountEl) amountEl.placeholder = 'boleh parsial';
  }
}

function resetPlanForm() {
  const sel = document.getElementById('plInvoice');
  if (sel) sel.value = '';
  const searchEl = document.getElementById('plInvSearch');
  if (searchEl) searchEl.value = '';
  state.planInvoiceSearch = '';
  const amountEl = document.getElementById('plAmount');
  if (amountEl) amountEl.value = '';
  const noteEl = document.getElementById('plNote');
  if (noteEl) noteEl.value = '';
  const dateEl = document.getElementById('plDate');
  if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);
  renderPlanInvoiceOptions();          // tampilkan lagi seluruh opsi
  void fillPlanInvoiceOptions();       // pastikan cache invoice terisi bila belum
  onPlanInvoiceChange();
}

async function submitPlan() {
  if (!state.canManagePlan) { toast('Tidak ada akses mengelola rencana bayar', true); return; }

  const sel = document.getElementById('plInvoice');
  const dateEl = document.getElementById('plDate');
  const amountEl = document.getElementById('plAmount');
  const noteEl = document.getElementById('plNote');

  const invoiceId = Number(sel?.value || 0);
  const planDate = dateEl?.value || '';
  const currency = sel?.selectedOptions?.[0]?.dataset?.curr || 'IDR';
  const amountRaw = amountEl?.value || '';
  const amount = currency === 'USD' ? parseNumberUsd(amountRaw) : parseNumberId(amountRaw);
  const note = (noteEl?.value || '').trim() || null;

  if (!invoiceId) { toast('Pilih invoice dulu', true); return; }
  if (!planDate) { toast('Tanggal rencana wajib diisi', true); return; }
  if (!amount || isNaN(amount) || amount <= 0) { toast('Jumlah rencana bayar harus > 0', true); return; }

  const btn = document.getElementById('plSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Memproses...'; }

  try {
    await addPaymentPlan({
      invoice_id: invoiceId,
      plan_date: planDate,
      plan_amount: amount,
      note
    });
    toast(`✓ Invoice masuk antrian rencana bayar (${currency} ${fmt(amount)})`);
    resetPlanForm();
    document.getElementById('plInvSearch')?.focus();
    await loadPlans();
  } catch (err) {
    toast('Gagal: ' + (err.message || err), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Tambah ke Antrian'; }
  }
}

// Simpan perubahan inline (tanggal / nominal) satu baris antrian.
async function savePlanInline(planId) {
  if (!state.canManagePlan) return;

  const plan = (state.plans || []).find(p => Number(p.id) === planId);
  if (!plan) return;

  const tr = document.querySelector(`#tbody-plans tr[data-plan-row="${planId}"]`);
  if (!tr) return;

  const dateVal = tr.querySelector('.plan-date-input')?.value || '';
  const amountRaw = tr.querySelector('.plan-amount-input')?.value || '';
  const currency = plan.currency === 'USD' ? 'USD' : 'IDR';
  const amount = currency === 'USD' ? parseNumberUsd(amountRaw) : parseNumberId(amountRaw);

  if (!dateVal) {
    toast('Tanggal rencana wajib diisi', true);
    renderPlans();
    return;
  }
  if (!amount || isNaN(amount) || amount <= 0) {
    toast('Jumlah rencana bayar harus > 0', true);
    renderPlans();
    return;
  }

  const sameDate = dateVal === (plan.plan_date || '');
  const sameAmount = Math.abs(amount - Number(plan.plan_amount || 0)) < 0.005;
  if (sameDate && sameAmount) return;

  try {
    await updatePaymentPlan({
      id: planId,
      plan_date: dateVal,
      plan_amount: amount,
      note: plan.note || null
    });
    toast(sameDate
      ? 'Rencana bayar diperbarui'
      : '✓ Tanggal diubah — antrian diurutkan ulang menurut tanggal');
    await loadPlans();
  } catch (err) {
    toast('Gagal simpan: ' + (err.message || err), true);
    await loadPlans(); // kembalikan nilai dari server
  }
}

async function movePlan(planId, direction) {
  if (!state.canManagePlan) { toast('Tidak ada akses mengubah urutan', true); return; }
  try {
    await movePaymentPlan(planId, direction);
    await loadPlans();
  } catch (err) {
    toast('Gagal geser urutan: ' + (err.message || err), true);
  }
}

async function deletePlan(planId) {
  if (!state.canManagePlan) { toast('Tidak ada akses menghapus antrian', true); return; }

  const plan = (state.plans || []).find(p => Number(p.id) === planId);
  const label = plan?.invoice?.invoice_no || `#${planId}`;
  if (!confirm(`Keluarkan ${label} dari antrian rencana bayar?`)) return;

  try {
    await deletePaymentPlan(planId);
    toast(`✓ ${label} keluar dari antrian`);
    await loadPlans();
  } catch (err) {
    toast('Gagal hapus: ' + (err.message || err), true);
  }
}

function bindPlanTab() {
  const dateEl = document.getElementById('plDate');
  if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);

  const formCard = document.getElementById('planFormCard');
  if (formCard) formCard.style.display = state.canManagePlan ? 'block' : 'none';

  document.getElementById('plInvoice')?.addEventListener('change', onPlanInvoiceChange);
  document.getElementById('plSaveBtn')?.addEventListener('click', submitPlan);
  document.getElementById('plResetBtn')?.addEventListener('click', resetPlanForm);

  // Kotak pencarian invoice/vendor: filter opsi dropdown tanpa query ulang.
  const searchEl = document.getElementById('plInvSearch');
  if (searchEl) {
    let tmr = null;
    const applySearch = () => {
      state.planInvoiceSearch = searchEl.value || '';
      renderPlanInvoiceOptions();
    };
    searchEl.addEventListener('input', () => {
      clearTimeout(tmr);
      tmr = setTimeout(applySearch, 200);
    });
    searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        searchEl.value = '';
        applySearch();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(tmr);
        applySearch();
        // Enter = pilih hasil pertama, lalu langsung ke kolom nominal.
        const sel = document.getElementById('plInvoice');
        if (sel && sel.options.length > 1) {
          sel.selectedIndex = 1;
          onPlanInvoiceChange();
          document.getElementById('plAmount')?.focus();
        }
      }
    });
  }

  document.getElementById('planRefreshBtn')?.addEventListener('click', async () => {
    state.plansLoaded = false;
    await loadPlans();
  });
}


// ============================================================
// AGING
// ============================================================
async function loadAging() {
  const tbody = document.getElementById('tbody-aging');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:16px;">Memuat...</td></tr>';
  try {
    const rows = await agingHutang({});
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:16px;">Tidak ada hutang.</td></tr>';
      return;
    }
    let t0 = 0, t31 = 0, t60 = 0, tAll = 0;
    tbody.innerHTML = rows.map(r => {
      t0 += r.b0_30; t31 += r.b31_60; t60 += r.b60p; tAll += r.total;
      return `
        <tr>
          <td data-label="Vendor">${esc(r.name)}</td>
          <td data-label="0–30 hari" class="num">${fmt(r.b0_30)}</td>
          <td data-label="31–60 hari" class="num">${fmt(r.b31_60)}</td>
          <td data-label="60+ hari" class="num">${fmt(r.b60p)}</td>
          <td data-label="Total" class="num" style="font-weight:600;">${fmt(r.total)}</td>
        </tr>`;
    }).join('') + `
      <tr style="background:#f9fafb;font-weight:600;">
        <td data-label="Vendor">TOTAL</td>
        <td data-label="0–30 hari" class="num">${fmt(t0)}</td>
        <td data-label="31–60 hari" class="num">${fmt(t31)}</td>
        <td data-label="60+ hari" class="num">${fmt(t60)}</td>
        <td data-label="Total" class="num">${fmt(tAll)}</td>
      </tr>`;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#dc2626;">${esc(err.message)}</td></tr>`;
  }
}

// ============================================================
// TAB CLEARING
// ============================================================
function wireClearingForm() {
  const form = document.getElementById('form-clearing');
  if (!form || form.dataset.wired === '1') return;
  form.dataset.wired = '1';

  const dateEl = document.getElementById('clearDate');
  if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);

  document.getElementById('addAllocBtn')?.addEventListener('click', () => addAllocRow());

  document.getElementById('clearResetBtn')?.addEventListener('click', () => {
    const tbody = document.getElementById('tbody-alloc');
    tbody.innerHTML = `
      <tr class="alloc-placeholder">
        <td colspan="5" style="text-align:center;color:#9ca3af;padding:8px;">
          Belum ada alokasi. Klik "+ Tambah Alokasi".
        </td>
      </tr>`;
    state.allocRowCount = 0;
    updateAllocTotal();
    document.getElementById('clearNote').value = '';
  });

  document.getElementById('clearRefreshBtn')?.addEventListener('click', () => loadClearingHistory());

  form.addEventListener('submit', submitClearing);

  loadClearingInvoices();
}

async function loadClearingInvoices() {
  const { data, error } = await supabase
    .from('purchase_invoices')
    .select('id, invoice_no, currency, total_idr, partner:partners!inner(name)')
    .in('status', ['posted', 'partial'])
    .order('invoice_no');
  if (error) { console.error('loadClearingInvoices:', error); return; }
  state.clearingInvoices = data || [];
}

function addAllocRow() {
  state.allocRowCount++;
  const tbody = document.getElementById('tbody-alloc');
  const ph = tbody.querySelector('.alloc-placeholder');
  if (ph) ph.remove();

  const tr = document.createElement('tr');
  tr.dataset.allocId = state.allocRowCount;
  const invoices = state.clearingInvoices || [];

  tr.innerHTML = `
    <td data-label="Invoice">
      <select class="alloc-invoice" required style="width:100%;padding:6px;border:1px solid #d0d5dd;border-radius:6px;">
        <option value="">— pilih invoice —</option>
        ${invoices.map(i =>
          `<option value="${i.id}">${esc(i.invoice_no)} — ${esc(i.partner?.name || '')} (${esc(i.currency)})</option>`
        ).join('')}
      </select>
    </td>
    <td data-label="Line (opsional)">
      <select class="alloc-line" style="width:100%;padding:6px;border:1px solid #d0d5dd;border-radius:6px;">
        <option value="">— (invoice saja) —</option>
      </select>
    </td>
    <td data-label="Jumlah (IDR)" class="num">
      <input type="number" class="alloc-amount" step="0.01" min="0.01" required
             style="width:100%;padding:6px;border:1px solid #d0d5dd;border-radius:6px;text-align:right;">
    </td>
    <td data-label="Catatan">
      <input type="text" class="alloc-note" maxlength="200"
             style="width:100%;padding:6px;border:1px solid #d0d5dd;border-radius:6px;">
    </td>
    <td>
      <button type="button" class="line-remove" title="Hapus"
              style="background:#fee2e2;color:#991b1b;border:none;border-radius:5px;width:26px;height:26px;font-size:14px;cursor:pointer;font-weight:700;">×</button>
    </td>
  `;
  tbody.appendChild(tr);

  tr.querySelector('.alloc-invoice').addEventListener('change', async (e) => {
    const invoiceId = Number(e.target.value);
    const lineSel = tr.querySelector('.alloc-line');
    lineSel.innerHTML = '<option value="">— (invoice saja) —</option>';
    if (!invoiceId) return;

    const { data: lines, error } = await supabase
      .from('purchase_invoice_lines')
      .select('id, line_no, display_name, qty, qty_unit, unit_price')
      .eq('invoice_id', invoiceId)
      .order('line_no');
    if (error) { console.error('loadLines:', error); return; }
    (lines || []).forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id;
      opt.textContent = `${l.line_no} — ${l.display_name} (${l.qty} ${l.qty_unit})`;
      lineSel.appendChild(opt);
    });
  });

  tr.querySelector('.alloc-amount').addEventListener('input', updateAllocTotal);

  tr.querySelector('.line-remove').addEventListener('click', () => {
    tr.remove();
    updateAllocTotal();
    if (!document.querySelectorAll('#tbody-alloc tr[data-alloc-id]').length) {
      tbody.innerHTML = `
        <tr class="alloc-placeholder">
          <td colspan="5" style="text-align:center;color:#9ca3af;padding:8px;">
            Belum ada alokasi. Klik "+ Tambah Alokasi".
          </td>
        </tr>`;
      state.allocRowCount = 0;
    }
  });

  updateAllocTotal();
}

function updateAllocTotal() {
  let total = 0;
  document.querySelectorAll('#tbody-alloc .alloc-amount').forEach(inp => {
    total += Number(inp.value) || 0;
  });
  const el = document.getElementById('allocTotal');
  if (el) el.textContent = 'Rp ' + total.toLocaleString('id-ID');
}

function collectAllocations() {
  const rows = document.querySelectorAll('#tbody-alloc tr[data-alloc-id]');
  const allocs = [];
  for (const tr of rows) {
    const invoiceId = Number(tr.querySelector('.alloc-invoice').value);
    const lineId = tr.querySelector('.alloc-line').value ? Number(tr.querySelector('.alloc-line').value) : null;
    const amount = Number(tr.querySelector('.alloc-amount').value);
    const note = tr.querySelector('.alloc-note').value.trim() || null;

    if (!invoiceId) { toast('Semua alokasi harus pilih invoice', true); return null; }
    if (!amount || amount <= 0) { toast('Jumlah alokasi harus > 0', true); return null; }
    allocs.push({ invoice_id: invoiceId, line_id: lineId, amount_idr: amount, note });
  }
  if (!allocs.length) { toast('Minimal 1 alokasi', true); return null; }
  return allocs;
}

async function submitClearing(e) {
  e.preventDefault();
  if (!state.canManage) { toast('Tidak ada akses konsolidasi', true); return; }

  const dateEl = document.getElementById('clearDate');
  const btn = document.getElementById('clearSaveBtn');
  const clearingDate = dateEl.value;
  if (!clearingDate) { toast('Tanggal wajib diisi', true); return; }

  const allocs = collectAllocations();
  if (allocs === null) return;

  const total = allocs.reduce((s, a) => s + a.amount_idr, 0);
  if (!confirm(`Konsolidasi ${allocs.length} alokasi, total Rp ${total.toLocaleString('id-ID')}?\n\nNilai akan ditambahkan ke avg_cost item terkait (jika dialokasikan ke line).`)) return;

  btn.disabled = true;
  btn.textContent = 'Memproses...';

  try {
    const { data, error } = await supabase.rpc('consolidate_clearing', {
      p_clearing_date: clearingDate,
      p_allocations: allocs
    });
    if (error) throw error;

    const result = data || {};
    const inserted = result.inserted || 0;
    const jn = result.journal_no ? ` · Jurnal ${result.journal_no}` : '';
    const errs = result.errors?.length || 0;

    toast(`✓ Konsolidasi selesai: ${inserted} alokasi${jn}${errs ? ` (${errs} error)` : ''}`);

    document.getElementById('clearResetBtn').click();
    await loadClearingHistory();
  } catch (err) {
    toast('Gagal konsolidasi: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Konsolidasi';
  }
}

async function loadClearingHistory() {
  const tbody = document.getElementById('tbody-clearing');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  const { data, error } = await supabase
    .from('clearing_allocations')
    .select(`
      id, clearing_date, amount_idr, note, journal_id, created_at,
      invoice:purchase_invoices(id, invoice_no),
      line:purchase_invoice_lines(id, line_no, display_name)
    `)
    .order('clearing_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(100);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:#dc2626;">${esc(error.message)}</td></tr>`;
    return;
  }

  if (!data || !data.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Belum ada alokasi clearing.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(r => `
    <tr>
      <td data-label="Tanggal">${fmtDate(r.clearing_date)}</td>
      <td data-label="Invoice" style="font-family:monospace;font-size:12px;">${esc(r.invoice?.invoice_no || '—')}</td>
      <td data-label="Line">${r.line?.line_no ?? '—'} — ${esc(r.line?.display_name || '—')}</td>
      <td data-label="Jumlah (IDR)" class="num">${fmt(r.amount_idr)}</td>
      <td data-label="Catatan">${esc(r.note || '')}</td>
      <td data-label="Jurnal">${r.journal_id ? `<span style="background:#dbeafe;color:#1e40af;padding:2px 6px;border-radius:4px;">JV</span>` : '—'}</td>
      <td data-label="Oleh">${r.created_at ? new Date(r.created_at).toLocaleString('id-ID') : '—'}</td>
    </tr>
  `).join('');
}

// ============================================================
// EXPORT CSV
// ============================================================
async function exportInvoices() {
  toast('Menyiapkan export invoice...');
  let q = supabase.from('purchase_invoices')
    .select(`
      invoice_no, dev_date, due_date, terms_days_actual, terms_days_standard,
      currency, exchange_rate, subtotal, total_usd, ppn_amount_idr, total_idr,
      clearing_cost_idr, customs_note, status, partner:partners!inner(name)
    `)
    .order('dev_date', { ascending: true })
    .order('invoice_no', { ascending: true });
  q = await applyFilters(q);
  const { data, error } = await q;
  if (error) { toast('Gagal: ' + error.message, true); return; }

  const headers = [
    'invoice_no','vendor','dev_date','due_date',
    'terms_actual','terms_std','currency','exchange_rate',
    'subtotal','total_usd','ppn_idr','total_idr',
    'clearing_cost_idr','customs_note','status'
  ];
  const rows = (data || []).map(r => [
    r.invoice_no, r.partner?.name, r.dev_date, r.due_date,
    r.terms_days_actual, r.terms_days_standard, r.currency, r.exchange_rate,
    r.subtotal, r.total_usd, r.ppn_amount_idr, r.total_idr,
    r.clearing_cost_idr, r.customs_note, r.status
  ]);
  const ts = new Date().toISOString().slice(0,10).replace(/-/g,'');
  downloadCSV(`purchase-invoices-${ts}.csv`, headers, rows);
  toast(`✓ Export ${rows.length} invoice`);
}

async function exportLines() {
  toast('Menyiapkan export line...');
  let q = supabase.from('purchase_invoices')
    .select('id, invoice_no, dev_date, currency, partner:partners!inner(name)')
    .order('dev_date', { ascending: true });
  q = await applyFilters(q);
  const { data: invs, error: e1 } = await q;
  if (e1) { toast('Gagal: ' + e1.message, true); return; }
  if (!invs || !invs.length) { toast('Tidak ada data'); return; }

  const ids = invs.map(i => i.id);
  const allLines = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data: lines, error: e2 } = await supabase
      .from('purchase_invoice_lines')
      .select(`
        invoice_id, line_no, display_name, qty, qty_unit,
        total_kg, total_ltr,
        unit_price, unit_price_idr, line_total, line_total_idr,
        exchange_rate, ppn_rate, ppn_amount_idr, clearing_cost_idr, remark,
        item:items!inner(sku, name)
      `)
      .in('invoice_id', chunk)
      .order('invoice_id').order('line_no');
    if (e2) { toast('Gagal: ' + e2.message, true); return; }
    allLines.push(...(lines || []));
  }

  const invMap = {};
  invs.forEach(i => { invMap[i.id] = i; });

  const headers = [
    'invoice_no','vendor','dev_date','currency','line_no','sku','display_name',
    'qty','qty_unit','total_kg','total_ltr',
    'unit_price','unit_price_idr','line_total','line_total_idr',
    'exchange_rate','ppn_rate','ppn_idr','clearing_cost_idr','remark'
  ];
  const rows = allLines.map(l => {
    const inv = invMap[l.invoice_id] || {};
    return [
      inv.invoice_no, inv.partner?.name, inv.dev_date, inv.currency,
      l.line_no, l.item?.sku, l.display_name || l.item?.name,
      l.qty, l.qty_unit, l.total_kg, l.total_ltr,
      l.unit_price, l.unit_price_idr, l.line_total, l.line_total_idr,
      l.exchange_rate, l.ppn_rate, l.ppn_amount_idr, l.clearing_cost_idr, l.remark
    ];
  });
  const ts = new Date().toISOString().slice(0,10).replace(/-/g,'');
  downloadCSV(`purchase-lines-${ts}.csv`, headers, rows);
  toast(`✓ Export ${rows.length} line`);
}

// ============================================================
// BIND FILTER
// ============================================================
function bindFilters() {
  const bind = (id, key) => {
    document.getElementById(id).addEventListener('change', () => {
      state.filters[key] = document.getElementById(id).value;
      state.page = 1;
      loadInvoices();
    });
  };
  bind('fPartner', 'partner_id');
  bind('fStatus', 'status');
  bind('fCurrency', 'currency');
  bind('fFrom', 'from');
  bind('fTo', 'to');

  let timer;
  document.getElementById('fSearch').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.filters.search = document.getElementById('fSearch').value;
      state.page = 1;
      loadInvoices();
    }, 350);
  });

  document.getElementById('fResetBtn').addEventListener('click', () => {
    state.filters = { search:'', partner_id:'', status:'', currency:'', from:'', to:'' };
    ['fSearch','fPartner','fStatus','fCurrency','fFrom','fTo'].forEach(id => {
      document.getElementById(id).value = '';
    });
    state.page = 1;
    loadInvoices();
  });
}

// ============================================================
// INIT
// ============================================================
(async () => {
  const user = await requireAuth();
  if (!user) return;

  const role = await requirePageAccess('hutang');
  if (!role) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('roleBadge').textContent = `(${role})`;

  await preloadPermissions();
  await renderNav(document.getElementById('mainNav'), 'hutang');

  state.canViewInvoice   = await hasPermission('finance.hutang.view');
  state.canViewAging     = await hasPermission('finance.hutang.detail');
  state.canExport        = await hasPermission('finance.hutang.view');
  state.canCreatePayment = await hasPermission('finance.hutang.payment.create');
  state.canDeletePayment = await hasPermission('finance.hutang.payment.delete');
  state.canManage        = await hasPermission('finance.hutang.manage');
  state.canManagePlan    = await hasPermission('finance.hutang.plan.manage');
  state.canViewPlan      = state.canManagePlan || await hasPermission('finance.hutang.plan.view');

  const tabPerms = {
    invoice: state.canViewInvoice,
    payment: state.canViewInvoice,
    plan:    state.canViewPlan,
    aging:   state.canViewAging,
    clearing: state.canManage
  };
  let firstAllowed = null;
  document.querySelectorAll('.tabs button').forEach(btn => {
    const tab = btn.dataset.tab;
    if (tabPerms[tab] === false) btn.style.display = 'none';
    else if (tabPerms[tab] === true && !firstAllowed) firstAllowed = tab;
  });

  if (!firstAllowed) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#dc2626;">Anda tidak punya akses ke halaman ini.</div>';
    return;
  }

  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
  document.querySelector(`.tabs button[data-tab="${firstAllowed}"]`).classList.add('active');
  document.getElementById('tab-' + firstAllowed).style.display = 'block';
  state.activeTab = firstAllowed;

  bindTabs();
  bindFilters();
  bindPaymentTab();
  bindPlanTab();

  const formCard = document.getElementById('paymentFormCard');
  formCard.style.display = state.canCreatePayment ? 'block' : 'none';

  const clearingFormCard = document.getElementById('clearingFormCard');
  clearingFormCard.style.display = state.canManage ? 'block' : 'none';

  document.getElementById('exportInvBtn').style.display = state.canExport ? 'inline-block' : 'none';
  document.getElementById('exportLineBtn').style.display = state.canExport ? 'inline-block' : 'none';
  document.getElementById('exportInvBtn').addEventListener('click', exportInvoices);
  document.getElementById('exportLineBtn').addEventListener('click', exportLines);
  document.getElementById('detailCloseBtn').addEventListener('click', closeDetail);
  document.getElementById('detailModal').addEventListener('click', (e) => {
    if (e.target.id === 'detailModal') closeDetail();
  });

  await loadFilterOptions();
  await loadBankAccounts();

  if (state.activeTab === 'invoice') await loadInvoices();
  else if (state.activeTab === 'aging') await loadAging();
  else if (state.activeTab === 'plan') await loadPlans();
  else if (state.activeTab === 'payment') {
    await loadPaymentInvoices();
    state.paymentsLoaded = true;
    await loadPayments();
  } else if (state.activeTab === 'clearing') {
    wireClearingForm();
    await loadClearingHistory();
    state.clearingLoaded = true;
  }
})();