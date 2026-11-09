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
function parseNumberId(s) {
  if (s === null || s === undefined) return NaN;
  let t = String(s).trim();
  if (!t) return NaN;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/\./g, '');
  return Number(t);
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
  selectedInvoice: null,
  paymentsLoaded: false,
  bankAccounts: [],
  clearingLoaded: false
};

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
function applyFilters(q) {
  const f = state.filters;
  if (f.search) {
    q = q.or(`invoice_no.ilike.%${f.search}%,partners.name.ilike.%${f.search}%`);
  }
  if (f.partner_id) q = q.eq('partner_id', f.partner_id);
  if (f.status) q = q.eq('status', f.status);
  if (f.currency) q = q.eq('currency', f.currency);
  if (f.from) q = q.gte('dev_date', f.from);
  if (f.to) q = q.lte('dev_date', f.to);
  return q;
}

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

  q = applyFilters(q);

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
  const f = state.filters;
  if (f.search) q = q.ilike('invoice_no', `%${f.search}%`);
  if (f.partner_id) q = q.eq('partner_id', f.partner_id);
  if (f.status) q = q.eq('status', f.status);
  if (f.currency) q = q.eq('currency', f.currency);
  if (f.from) q = q.gte('dev_date', f.from);
  if (f.to) q = q.lte('dev_date', f.to);

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
// BANK ACCOUNTS
// ============================================================
async function loadBankAccounts() {
  const { data, error } = await supabase
    .from('accounts')
    .select('id, code, name')
    .eq('is_active', true)
    .like('code', '1-1%')
    .order('code');
  if (error) { console.error(error); return; }
  state.bankAccounts = (data || []).filter(a => !a.code.startsWith('1-12'));

  const sel = document.getElementById('pAccount');
  sel.innerHTML = '<option value="">— pilih rekening —</option>' +
    state.bankAccounts.map(a =>
      `<option value="${a.id}">${esc(a.code)} — ${esc(a.name)}</option>`
    ).join('');
}

// ============================================================
// TAB PEMBAYARAN
// ============================================================
async function loadPaymentInvoices() {
  const { data, error } = await supabase
    .from('purchase_invoices')
    .select(`id, invoice_no, partner:partners!inner(name), total_idr, currency`)
    .in('status', ['posted','partial'])
    .order('invoice_no', { ascending: true });

  if (error) { console.error(error); return; }
  state.payInvoicesCache = data || [];

  const sel = document.getElementById('pInvoice');
  sel.innerHTML = '<option value="">— pilih invoice —</option>' +
    state.payInvoicesCache.map(i =>
      `<option value="${i.id}">${esc(i.invoice_no)} — ${esc(i.partner?.name || '')} (${esc(i.currency)})</option>`
    ).join('');
}

async function onInvoiceSelect(invoiceId) {
  if (!invoiceId) {
    state.selectedInvoice = null;
    document.getElementById('paymentSummaryCard').style.display = 'none';
    return;
  }
  const { data: inv, error } = await supabase
    .from('purchase_invoices')
    .select(`id, invoice_no, total_idr, manual_payment_idr, status, partner:partners!inner(name)`)
    .eq('id', invoiceId)
    .single();
  if (error) { toast('Gagal memuat invoice: ' + error.message, true); return; }
  state.selectedInvoice = inv;

  const total = Number(inv.total_idr || 0);
  const manual = Number(inv.manual_payment_idr || 0);
  const sisa = total - manual;

  document.getElementById('psInvNo').textContent = inv.invoice_no;
  document.getElementById('psPartner').textContent = inv.partner?.name || '';
  document.getElementById('psTotal').textContent = 'Rp ' + fmt(total);
  document.getElementById('psManual').textContent = 'Rp ' + fmt(manual);
  document.getElementById('psSisa').textContent = 'Rp ' + fmt(sisa);
  document.getElementById('psStatus').innerHTML = statusBadge(inv.status);
  document.getElementById('paymentSummaryCard').style.display = 'block';

  document.getElementById('pAmount').value = sisa > 0 ? String(Math.round(sisa)) : '';
}

async function loadPayments() {
  const tbody = document.getElementById('tbody-payments');
  tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#9ca3af;padding:16px;">Memuat...</td></tr>';

  let q = supabase
    .from('purchase_payments')
    .select(`
      id, payment_date, amount_idr, amount_usd, method, reference_no, note, created_at, journal_id,
      account:accounts(id, code, name),
      invoice:purchase_invoices!inner(
        id, invoice_no,
        partner:partners!inner(name)
      )
    `)
    .order('payment_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(500);

  // Catatan: tabel purchase_payments belum ada — perlu dibuat di Phase 2.
  // Untuk Phase 1, kita skip loadPayments (tampilkan "belum ada pembayaran").

  tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#9ca3af;padding:16px;">Fitur pembayaran hutang akan tersedia di Phase 2.</td></tr>';
  document.getElementById('payTotalInfo').textContent = '';
}

function renderPaymentsTable(rows) {
  // Placeholder — Phase 2
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
  q = applyFilters(q);
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
  q = applyFilters(q);
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
// BIND FILTER (invoice)
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

function bindPaymentTab() {
  const sel = document.getElementById('pInvoice');
  sel.addEventListener('change', () => onInvoiceSelect(sel.value));

  const methodSel = document.getElementById('pMethod');
  const accWrap   = document.getElementById('pAccountWrap');
  function toggleAcc() {
    const m = methodSel.value;
    accWrap.style.display = ['transfer','cash','giro'].includes(m) ? '' : 'none';
  }
  methodSel.addEventListener('change', toggleAcc);
  toggleAcc();

  document.getElementById('pSaveBtn').addEventListener('click', () => {
    toast('Fitur pembayaran hutang akan tersedia di Phase 2.', true);
  });

  let timer;
  document.getElementById('paySearch').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.payFilters.search = document.getElementById('paySearch').value;
      loadPayments();
    }, 350);
  });

  document.getElementById('pDate').value = new Date().toISOString().slice(0,10);
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
    await loadClearingHistory();
    state.clearingLoaded = true;
  }
})();