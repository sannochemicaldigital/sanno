// js/hutang-page.js
import { supabase } from './supabase-client.js';
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission, preloadPermissions } from './permissions.js';
import { agingHutang } from './reports.js';

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
  payAllocCount: 0
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
      <td style="font-family:monospace;font-size:12px;">${esc(r.invoice_no)}</td>
      <td>${esc(r.partner?.name || '—')}</td>
      <td>${fmtDate(r.dev_date)}</td>
      <td>${fmtDate(r.due_date)}</td>
      <td>${esc(r.currency)}</td>
      <td class="num">${fmt(r.subtotal)}</td>
      <td class="num">${fmt(r.ppn_amount_idr)}</td>
      <td class="num" style="font-weight:600;">${fmt(r.total_idr)}</td>
      <td>${statusBadge(r.status)}</td>
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
        <td>${l.line_no}</td>
        <td style="font-family:monospace;font-size:12px;">${esc(l.item?.sku || '—')}</td>
        <td>${esc(l.display_name || l.item?.name || '—')}</td>
        <td class="num">${fmtInt(l.qty)}</td>
        <td>${esc(l.qty_unit)}</td>
        <td class="num">${fmt(l.unit_price)}</td>
        <td class="num">${fmt(l.line_total)}</td>
        <td class="num">${fmt(l.ppn_amount_idr)}</td>
        <td style="font-size:12px;color:#6b7280;">${esc(l.remark || '')}</td>
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
  function toggleFx() {
    fxWrap.style.display = curSel.value === 'USD' ? '' : 'none';
    document.getElementById('payTotalCur').textContent = curSel.value;
    resetPayAlloc();
    updatePaymentTotal();
  }
  curSel.addEventListener('change', toggleFx);
  toggleFx();

  document.getElementById('pAddAllocBtn').addEventListener('click', () => addPayAllocRow());
  document.getElementById('pResetBtn').addEventListener('click', () => {
    document.getElementById('pNote').value = '';
    document.getElementById('pFxRate').value = '';
    document.getElementById('pDate').value = new Date().toISOString().slice(0, 10);
    resetPayAlloc();
    updatePaymentTotal();
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
    <td>
      <select class="pay-alloc-invoice" required style="width:100%;padding:6px;border:1px solid #d0d5dd;border-radius:6px;">
        <option value="">— pilih invoice —</option>
        ${candidates.map(i =>
          `<option value="${i.id}" data-sisa="${i.sisa}">${esc(i.invoice_no)} — ${esc(i.partner?.name || '')} (sisa ${fmt(i.sisa)})</option>`
        ).join('')}
      </select>
    </td>
    <td class="num pay-alloc-sisa" style="color:#6b7280;">—</td>
    <td class="num">
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
    document.getElementById('payTotalIdr').textContent = fx > 0 ? fmt(total * fx) : '— (isi kurs beli)';
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
  if (currency === 'USD' && (!fx || fx <= 0)) { toast('Kurs beli USD wajib diisi', true); return; }

  const allocs = collectPaymentAllocs();
  if (allocs === null) return;

  const total = allocs.reduce((s, a) => s + a.amount, 0);
  const confirmMsg = `Simpan pembayaran ${currency} ${fmt(total)}` +
    (currency === 'USD' ? ` @ kurs ${fmt(fx)} (≈ Rp ${fmt(total * fx)})` : '') +
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
        <td style="font-family:monospace;font-size:12px;">${esc(r.payment_no)}</td>
        <td>${fmtDate(r.payment_date)}</td>
        <td>${esc(r.currency)}</td>
        <td style="font-size:12px;">${esc(r.bank_coa_code)}</td>
        <td class="num">${fmt(r.total_amount)}</td>
        <td class="num">${fmt(totalIdrRow)}</td>
        <td class="num" style="color:${selisihColor};">${selisihLabel}</td>
        <td style="font-size:12px;">${invNos.length ? invNos.map(esc).join(', ') : '—'}</td>
        <td style="font-size:12px;color:#6b7280;">${esc(r.note || '')}</td>
        <td>
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
          <td>${esc(r.name)}</td>
          <td class="num">${fmt(r.b0_30)}</td>
          <td class="num">${fmt(r.b31_60)}</td>
          <td class="num">${fmt(r.b60p)}</td>
          <td class="num" style="font-weight:600;">${fmt(r.total)}</td>
        </tr>`;
    }).join('') + `
      <tr style="background:#f9fafb;font-weight:600;">
        <td>TOTAL</td>
        <td class="num">${fmt(t0)}</td>
        <td class="num">${fmt(t31)}</td>
        <td class="num">${fmt(t60)}</td>
        <td class="num">${fmt(tAll)}</td>
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
    <td>
      <select class="alloc-invoice" required style="width:100%;padding:6px;border:1px solid #d0d5dd;border-radius:6px;">
        <option value="">— pilih invoice —</option>
        ${invoices.map(i =>
          `<option value="${i.id}">${esc(i.invoice_no)} — ${esc(i.partner?.name || '')} (${esc(i.currency)})</option>`
        ).join('')}
      </select>
    </td>
    <td>
      <select class="alloc-line" style="width:100%;padding:6px;border:1px solid #d0d5dd;border-radius:6px;">
        <option value="">— (invoice saja) —</option>
      </select>
    </td>
    <td class="num">
      <input type="number" class="alloc-amount" step="0.01" min="0.01" required
             style="width:100%;padding:6px;border:1px solid #d0d5dd;border-radius:6px;text-align:right;">
    </td>
    <td>
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
      <td>${fmtDate(r.clearing_date)}</td>
      <td style="font-family:monospace;font-size:12px;">${esc(r.invoice?.invoice_no || '—')}</td>
      <td>${r.line?.line_no ?? '—'} — ${esc(r.line?.display_name || '—')}</td>
      <td class="num">${fmt(r.amount_idr)}</td>
      <td>${esc(r.note || '')}</td>
      <td>${r.journal_id ? `<span style="background:#dbeafe;color:#1e40af;padding:2px 6px;border-radius:4px;">JV</span>` : '—'}</td>
      <td>${r.created_at ? new Date(r.created_at).toLocaleString('id-ID') : '—'}</td>
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

  const tabPerms = {
    invoice: state.canViewInvoice,
    payment: state.canViewInvoice,
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