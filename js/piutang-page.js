// js/piutang-page.js
import { supabase } from './supabase-client.js';
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission, preloadPermissions } from './permissions.js';
import { agingPiutang } from './reports.js';

// Penanda build: muncul di console + atribut <body data-build>.
// Dipakai untuk memastikan browser TIDAK memuat versi lama dari cache.
const BUILD = 'v10.2.2';
document.body.dataset.build = BUILD;
console.info('[piutang-page] build ' + BUILD +
  ' — Simpan: add_sales_receipt · Hapus: delete_sales_receipt');

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
// USD: titik = desimal (7371.50), koma = desimal bila tidak ada titik (7371,5),
// format Indonesia (7.371,50) tetap didukung.
function parseNumberUsd(s) {
  if (s === null || s === undefined) return NaN;
  let t = String(s).trim().replace(/\s/g, '');
  if (!t) return NaN;
  if (t.includes(',') && t.includes('.')) {
    t = t.replace(/\./g, '').replace(',', '.');
  } else if (t.includes(',')) {
    t = t.replace(',', '.');
  }
  return Number(t);
}

// ============================================================
// STATE
// ============================================================
const PAGE_SIZE = 50;
const state = {
  activeTab: 'invoice',
  page: 1,
  filters: { search: '', partner_id: '', sales_rep_id: '', status: '', currency: '', from: '', to: '' },
  total: 0,
  canExport: false,
  canViewInvoice: false,
  canViewAging: false,
  canViewPayment: false,
  canCreatePayment: false,
  canDeletePayment: false,
  payFilters: { search: '', from: '', to: '' },
  payInvoicesCache: [],
  selectedInvoice: null,
  paymentsLoaded: false,
  bankAccounts: []
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
      } else if (state.activeTab === 'payment' && state.canViewPayment) {
        if (!state.paymentsLoaded) {
          await loadPaymentInvoices();
          state.paymentsLoaded = true;
        }
        await loadPayments();
      }
    });
  });
}

// ============================================================
// FILTER OPTIONS
// ============================================================
async function loadFilterOptions() {
  const { data: partners } = await supabase
    .from('partners').select('id, name').order('name');
  const selP = document.getElementById('fPartner');
  (partners || []).forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    selP.appendChild(opt);
  });

  const { data: reps } = await supabase
    .from('sales_reps').select('id, code, name').order('code');
  const selS = document.getElementById('fSales');
  (reps || []).forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.id; opt.textContent = r.code;
    selS.appendChild(opt);
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
  if (f.sales_rep_id) q = q.eq('sales_rep_id', f.sales_rep_id);
  if (f.status) q = q.eq('status', f.status);
  if (f.currency) q = q.eq('currency', f.currency);
  if (f.from) q = q.gte('dev_date', f.from);
  if (f.to) q = q.lte('dev_date', f.to);
  return q;
}

async function loadInvoices() {
  const tbody = document.getElementById('tbody-invoices');
  tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#9ca3af;padding:16px;">Memuat...</td></tr>';

  const from = (state.page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let q = supabase
    .from('historical_invoices')
    .select(`
      id, invoice_no, dev_date, due_date, currency, exchange_rate,
      subtotal, ppn_amount_idr, total_idr, status,
      partner:partners!inner(id, name),
      sales_rep:sales_reps(id, code)
    `, { count: 'exact' })
    .order('dev_date', { ascending: false })
    .order('invoice_no', { ascending: false })
    .range(from, to);

  q = applyFilters(q);

  const { data, error, count } = await q;
  if (error) {
    console.error(error);
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:#dc2626;padding:16px;">Error: ${esc(error.message)}</td></tr>`;
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
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#9ca3af;padding:16px;">Tidak ada invoice.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr data-id="${r.id}" style="cursor:pointer;">
      <td data-label="Invoice No" style="font-family:monospace;font-size:12px;">${esc(r.invoice_no)}</td>
      <td data-label="Partner">${esc(r.partner?.name || '—')}</td>
      <td data-label="Sales">${esc(r.sales_rep?.code || '—')}</td>
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
    .from('historical_invoices')
    .select('subtotal, ppn_amount_idr, total_idr, currency', { count: 'exact' });
  const f = state.filters;
  if (f.search) q = q.ilike('invoice_no', `%${f.search}%`);
  if (f.partner_id) q = q.eq('partner_id', f.partner_id);
  if (f.sales_rep_id) q = q.eq('sales_rep_id', f.sales_rep_id);
  if (f.status) q = q.eq('status', f.status);
  if (f.currency) q = q.eq('currency', f.currency);
  if (f.from) q = q.gte('dev_date', f.from);
  if (f.to) q = q.lte('dev_date', f.to);

  const { data, error } = await q;
  if (error) { console.warn(error); return; }

  let subIdr = 0, subUsd = 0, ppn = 0, total = 0;
  (data || []).forEach(r => {
    if (r.currency === 'USD') subUsd += Number(r.subtotal || 0);
    else subIdr += Number(r.subtotal || 0);
    ppn   += Number(r.ppn_amount_idr || 0);
    total += Number(r.total_idr || 0);
  });

  document.getElementById('sumInvoices').textContent = fmtInt(state.total);
  document.getElementById('sumLines').textContent = fmtInt(data?.length || 0);
  document.getElementById('sumSubtotal').textContent =
    'IDR ' + fmt(subIdr) + (subUsd ? ' + USD ' + fmt(subUsd) : '');
  document.getElementById('sumPpn').textContent = 'IDR ' + fmt(ppn);
  document.getElementById('sumTotalIdr').textContent = 'IDR ' + fmt(total);
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
  const paySection = document.getElementById('detailPaymentsSection');
  const payBody = document.getElementById('detailPaymentsBody');
  const paySummary = document.getElementById('detailPaymentsSummary');
  modal.style.display = 'flex';
  headerEl.innerHTML = '<div style="color:#9ca3af;">Memuat...</div>';
  linesEl.innerHTML = '';
  paySection.style.display = 'none';
  payBody.innerHTML = '';
  paySummary.innerHTML = '';

  const { data: inv, error: e1 } = await supabase
    .from('historical_invoices')
    .select(`*, partner:partners!inner(id, name), sales_rep:sales_reps(id, code)`)
    .eq('id', invoiceId)
    .single();

  if (e1) {
    headerEl.innerHTML = `<div style="color:#dc2626;">Error: ${esc(e1.message)}</div>`;
    return;
  }

  document.getElementById('detailTitle').textContent = `Invoice ${inv.invoice_no}`;
  headerEl.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;background:#f9fafb;padding:12px;border-radius:8px;">
      <div><div style="font-size:11px;color:#6b7280;">Partner</div><div style="font-weight:600;">${esc(inv.partner?.name || '—')}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Sales</div><div style="font-weight:600;">${esc(inv.sales_rep?.code || '—')}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Dev Date</div><div>${fmtDate(inv.dev_date)}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Due Date</div><div>${fmtDate(inv.due_date)}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Terms</div><div>${inv.terms_days_actual} hari (std ${inv.terms_days_standard})</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Currency</div><div>${esc(inv.currency)}${inv.exchange_rate ? ' @ ' + fmt(inv.exchange_rate) : ''}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Status</div><div>${statusBadge(inv.status)}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Subtotal</div><div style="font-weight:600;">${fmt(inv.subtotal)}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">PPN (IDR)</div><div>${fmt(inv.ppn_amount_idr)}</div></div>
      <div><div style="font-size:11px;color:#6b7280;">Total IDR</div><div style="font-weight:600;color:#0891b2;">${fmt(inv.total_idr)}</div></div>
      ${inv.partial_payment_idr ? `<div style="grid-column:span 2;"><div style="font-size:11px;color:#6b7280;">Titip (DP)</div><div>${fmt(inv.partial_payment_idr)}</div>${inv.partial_payment_note ? `<div style="font-size:11px;color:#6b7280;">${esc(inv.partial_payment_note)}</div>` : ''}</div>` : ''}
      ${inv.commission_type ? `<div style="grid-column:span 2;"><div style="font-size:11px;color:#6b7280;">Titipan (komisi)</div><div>${esc(inv.commission_type)}${inv.commission_idr ? ' — ' + fmt(inv.commission_idr) : ''}</div>${inv.commission_note ? `<div style="font-size:11px;color:#6b7280;">${esc(inv.commission_note)}</div>` : ''}</div>` : ''}
      ${inv.paid_date ? `<div style="grid-column:span 2;"><div style="font-size:11px;color:#6b7280;">Paid</div><div>${fmtDate(inv.paid_date)}</div>${inv.paid_note ? `<div style="font-size:11px;color:#6b7280;">${esc(inv.paid_note)}</div>` : ''}</div>` : ''}
    </div>
  `;

  const { data: lines, error: e2 } = await supabase
    .from('historical_invoice_lines')
    .select(`*, item:items!inner(sku, name, nama_jual)`)
    .eq('invoice_id', invoiceId)
    .order('line_no');

  if (e2) {
    linesEl.innerHTML = `<tr><td colspan="9" style="color:#dc2626;">Error: ${esc(e2.message)}</td></tr>`;
    return;
  }
  if (!lines || !lines.length) {
    linesEl.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#9ca3af;padding:8px;">Tidak ada line.</td></tr>';
  } else {
    linesEl.innerHTML = lines.map(l => {
      const isi = l.packaging_isi_kg
        ? fmt(l.packaging_isi_kg) + ' kg'
        : (l.packaging_isi_ltr ? fmt(l.packaging_isi_ltr) + ' ltr' : '—');
      return `
        <tr>
          <td data-label="Line">${l.line_no}</td>
          <td data-label="SKU" style="font-family:monospace;font-size:12px;">${esc(l.item?.sku || '—')}</td>
          <td data-label="Nama">${esc(l.display_name || l.item?.name || '—')}</td>
          <td data-label="Qty" class="num">${fmtInt(l.qty)}</td>
          <td data-label="Isi" class="num">${isi}</td>
          <td data-label="Harga" class="num">${fmt(l.unit_price)}</td>
          <td data-label="Total" class="num">${fmt(l.line_total)}</td>
          <td data-label="PPN (IDR)" class="num">${fmt(l.ppn_amount_idr)}</td>
          <td data-label="Remark" style="font-size:12px;color:#6b7280;">${esc(l.remark || '')}</td>
        </tr>
      `;
    }).join('');
  }

  // Section Pembayaran
  const { data: pays, error: e3 } = await supabase
    .from('historical_invoice_payments')
    .select(`id, payment_date, amount_idr, amount_usd, exchange_rate_buy, method, reference_no, note, created_at, created_by, account:accounts(code, name)`)
    .eq('invoice_id', invoiceId)
    .order('payment_date', { ascending: true })
    .order('id', { ascending: true });

  if (!e3 && pays && pays.length) {
    paySection.style.display = 'block';
    const isUsd = String(inv.currency || 'IDR').toUpperCase() === 'USD';
    const totalManual = pays.reduce((s, p) => s + Number(p.amount_idr || 0), 0);
    const paidUsd = pays.reduce((s, p) => s + Number(p.amount_usd || 0), 0);
    const partial = Number(inv.partial_payment_idr || 0);
    const totalPaid = partial + totalManual;
    const sisa = Number(inv.total_idr || 0) - totalPaid;
    const sisaUsd = Number(inv.subtotal || 0) - paidUsd;

    payBody.innerHTML = pays.map(p => `
      <tr>
        <td data-label="Tanggal">${fmtDate(p.payment_date)}</td>
        <td data-label="Jumlah" class="num">${
          p.amount_usd !== null && p.amount_usd !== undefined
            ? `USD ${fmt(p.amount_usd)}<div style="font-size:11px;color:#6b7280;">Rp ${fmt(p.amount_idr)} @ ${fmt(p.exchange_rate_buy)}</div>`
            : `Rp ${fmt(p.amount_idr)}`
        }</td>
        <td data-label="Metode">${esc(p.method)}</td>
        <td data-label="Rekening" style="font-size:12px;">${esc(p.account?.code || '')} ${esc(p.account?.name || '')}</td>
        <td data-label="Ref" style="font-size:12px;">${esc(p.reference_no || '')}</td>
        <td data-label="Catatan" style="font-size:12px;">${esc(p.note || '')}</td>
        <td data-label="Oleh" style="font-size:11px;color:#6b7280;">${p.created_at ? new Date(p.created_at).toLocaleString('id-ID') : '—'}</td>
      </tr>
    `).join('');

    paySummary.innerHTML = `
      <div style="display:flex;gap:16px;flex-wrap:wrap;background:#f9fafb;padding:10px 12px;border-radius:8px;">
        <div><span style="color:#6b7280;">Total dibayar:</span> <strong>${fmt(totalPaid)}</strong></div>
        ${isUsd ? `<div><span style="color:#6b7280;">Diterima USD:</span> <strong>${fmt(paidUsd)}</strong></div>` : ''}
        <div><span style="color:#6b7280;">Excel (Titip):</span> ${fmt(partial)}</div>
        <div><span style="color:#6b7280;">Manual:</span> ${fmt(totalManual)}</div>
        <div><span style="color:#6b7280;">Sisa:</span> <strong style="color:${(isUsd ? sisaUsd : sisa) > 0 ? '#dc2626' : '#059669'};">${isUsd ? 'USD ' + fmt(sisaUsd) : fmt(sisa)}</strong></div>
      </div>
    `;
  } else if (pays && pays.length === 0) {
    const isUsd = String(inv.currency || 'IDR').toUpperCase() === 'USD';
    const partial = Number(inv.partial_payment_idr || 0);
    if (partial > 0 || isUsd) {
      paySection.style.display = 'block';
      payBody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:8px;">Belum ada pembayaran manual (hanya titip Excel).</td></tr>';
      paySummary.innerHTML = `<div style="background:#f9fafb;padding:10px 12px;border-radius:8px;">
        <span style="color:#6b7280;">Excel (Titip):</span> <strong>${fmt(partial)}</strong> ·
        <span style="color:#6b7280;">Sisa:</span> <strong style="color:#dc2626;">${isUsd ? 'USD ' + fmt(Number(inv.subtotal || 0) - Number(inv.paid_usd || 0)) : fmt(Number(inv.total_idr||0) - partial)}</strong>
      </div>`;
    }
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
      `<option value="${esc(a.code)}">${esc(a.code)} — ${esc(a.name)}</option>`
    ).join('');
}

// Kurs USD terakhir dari master kurs (dipakai sebagai default kurs beli).
async function latestUsdRate() {
  const { data, error } = await supabase
    .from('exchange_rates')
    .select('rate_to_base, rate_date')
    .eq('currency_code', 'USD')
    .order('rate_date', { ascending: false })
    .limit(1);
  if (error || !data || !data.length) return null;
  const r = Number(data[0].rate_to_base);
  return isNaN(r) || r <= 0 ? null : r;
}

// ============================================================
// TAB PEMBAYARAN
// ============================================================
async function loadPaymentInvoices() {
  const { data, error } = await supabase
    .from('historical_invoices')
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
    .from('historical_invoices')
    .select(`id, invoice_no, currency, subtotal, exchange_rate, paid_usd,
             total_idr, partial_payment_idr, manual_payment_idr, status,
             partner:partners!inner(name)`)
    .eq('id', invoiceId)
    .single();
  if (error) { toast('Gagal memuat invoice: ' + error.message, true); return; }
  state.selectedInvoice = inv;

  const isUsd   = String(inv.currency || 'IDR').toUpperCase() === 'USD';
  const total   = Number(inv.total_idr || 0);
  const partial = Number(inv.partial_payment_idr || 0);
  const manual  = Number(inv.manual_payment_idr || 0);
  const sisa    = total - partial - manual;
  // USD: sisa dihitung dalam mata uang asli (subtotal - SUM(amount_usd)), sama seperti RPC
  const sisaUsd = Number(inv.subtotal || 0) - Number(inv.paid_usd || 0);

  document.getElementById('psInvNo').textContent = inv.invoice_no;
  document.getElementById('psPartner').textContent = inv.partner?.name || '';
  document.getElementById('psTotal').textContent = isUsd
    ? `USD ${fmt(inv.subtotal)} @ ${fmt(inv.exchange_rate)}`
    : 'Rp ' + fmt(total);
  document.getElementById('psPartial').textContent = 'Rp ' + fmt(partial);
  document.getElementById('psManual').textContent = isUsd
    ? `USD ${fmt(inv.paid_usd)} (Rp ${fmt(manual)})`
    : 'Rp ' + fmt(manual);
  document.getElementById('psSisa').textContent = isUsd ? 'USD ' + fmt(sisaUsd) : 'Rp ' + fmt(sisa);
  document.getElementById('psStatus').innerHTML = statusBadge(inv.status);
  document.getElementById('paymentSummaryCard').style.display = 'block';

  // Form menyesuaikan mata uang invoice
  const lbl      = document.getElementById('pAmountLabel');
  const hint     = document.getElementById('pAmountHint');
  const rateWrap = document.getElementById('pRateBuyWrap');
  lbl.textContent = isUsd ? 'Jumlah (USD)' : 'Jumlah (IDR)';
  document.getElementById('pAmount').value = isUsd
    ? (sisaUsd > 0 ? sisaUsd.toFixed(2) : '')
    : (sisa > 0 ? String(Math.round(sisa)) : '');

  if (isUsd) {
    rateWrap.style.display = '';
    hint.textContent = `Sisa USD ${fmt(sisaUsd)} · kurs invoice ${fmt(inv.exchange_rate)}. ` +
      `Isi kurs beli (kurs realisasi) — selisih kurs otomatis ke 5-9100.`;
    const r = await latestUsdRate();
    const rate = r || Number(inv.exchange_rate || 0);
    document.getElementById('pRateBuy').value = rate > 0 ? String(Math.round(rate)) : '';
  } else {
    rateWrap.style.display = 'none';
    hint.textContent = '';
  }
}

async function loadPayments() {
  const tbody = document.getElementById('tbody-payments');
  tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#9ca3af;padding:16px;">Memuat...</td></tr>';

  let q = supabase
    .from('historical_invoice_payments')
    .select(`
      id, payment_date, amount_idr, amount_usd, exchange_rate_buy, selisih_kurs_idr,
      method, reference_no, note, created_at, journal_id,
      account:accounts(id, code, name),
      invoice:historical_invoices!inner(
        id, invoice_no,
        partner:partners!inner(name)
      )
    `)
    .order('payment_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(500);

  const pf = state.payFilters;
  if (pf.from) q = q.gte('payment_date', pf.from);
  if (pf.to) q = q.lte('payment_date', pf.to);
  if (pf.search) q = q.ilike('invoice.invoice_no', `%${pf.search}%`);

  const { data, error } = await q;
  if (error) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:#dc2626;padding:16px;">Error: ${esc(error.message)}</td></tr>`;
    return;
  }
  const rows = data || [];
  await attachJournalNos(rows);
  renderPaymentsTable(rows);
}

// Lengkapi journal_no tanpa bergantung pada embed FK: supaya tabel menampilkan
// awalan jurnal ASLI (REC-* = RPC v10.2, JV-* = add_historical_payment lama),
// bukan badge "JV" statis yang menyesatkan. Query dipecah agar URL tidak kepanjangan.
async function attachJournalNos(rows) {
  const ids = [...new Set(rows.map(r => r.journal_id).filter(v => v != null))];
  if (!ids.length) return;
  const map = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data, error } = await supabase
      .from('journals')
      .select('id, journal_no')
      .in('id', chunk);
    if (error) return;              // badge tetap tampil sebagai JV#<id>
    (data || []).forEach(j => map.set(j.id, j.journal_no));
  }
  rows.forEach(r => {
    r.journal_no = r.journal_id != null ? (map.get(r.journal_id) || null) : null;
  });
}

function journalBadge(r) {
  if (r.journal_id == null) return '—';
  const jn = r.journal_no || '';
  if (!jn) {
    return `<span title="journal_id ${esc(r.journal_id)}" style="background:#e5e7eb;color:#374151;padding:2px 6px;border-radius:4px;">JV#${esc(r.journal_id)}</span>`;
  }
  const isRec = jn.toUpperCase().startsWith('REC-');
  const style = isRec
    ? 'background:#dbeafe;color:#1e40af;'
    : 'background:#e5e7eb;color:#374151;';
  return `<span title="${esc(jn)}" style="${style}padding:2px 6px;border-radius:4px;font-family:monospace;">${esc(jn)}</span>`;
}

function renderPaymentsTable(rows) {
  const tbody = document.getElementById('tbody-payments');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#9ca3af;padding:16px;">Belum ada pembayaran.</td></tr>';
    document.getElementById('payTotalInfo').textContent = '';
    return;
  }
  const total = rows.reduce((s, r) => s + Number(r.amount_idr || 0), 0);

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td data-label="Invoice" style="font-family:monospace;font-size:12px;">${esc(r.invoice?.invoice_no || '—')}</td>
      <td data-label="Partner">${esc(r.invoice?.partner?.name || '—')}</td>
      <td data-label="Tanggal">${fmtDate(r.payment_date)}</td>
      <td data-label="Jumlah" class="num" style="font-weight:600;">${
        r.amount_usd !== null && r.amount_usd !== undefined
          ? `USD ${fmt(r.amount_usd)}<div style="font-size:11px;color:#6b7280;font-weight:400;">Rp ${fmt(r.amount_idr)} @ ${fmt(r.exchange_rate_buy)}</div>`
          : `Rp ${fmt(r.amount_idr)}`
      }</td>
      <td data-label="Metode">${esc(r.method)}</td>
      <td data-label="Rekening" style="font-size:12px;">${esc(r.account?.code || '')} ${esc(r.account?.name || '')}</td>
      <td data-label="Ref" style="font-size:12px;">${esc(r.reference_no || '')}</td>
      <td data-label="Oleh" style="font-size:11px;color:#6b7280;">${r.created_at ? new Date(r.created_at).toLocaleString('id-ID') : '—'}</td>
      <td data-label="Jurnal" style="font-size:11px;">${journalBadge(r)}</td>
      <td data-label="Aksi">
        ${state.canDeletePayment
          ? `<button type="button" class="btn btn-danger" data-del-pay="${r.id}" data-del-jv="${r.journal_id || ''}" style="padding:4px 10px;font-size:12px;">Hapus</button>`
          : '—'}
      </td>
    </tr>
  `).join('');

  document.getElementById('payTotalInfo').textContent =
    `Menampilkan ${rows.length} pembayaran · Total: Rp ${fmt(total)}`;

  tbody.querySelectorAll('button[data-del-pay]').forEach(btn => {
    btn.addEventListener('click', () => deletePayment(Number(btn.dataset.delPay), btn.dataset.delJv || null));
  });
}

async function submitPayment() {
  const inv       = state.selectedInvoice;
  const date      = document.getElementById('pDate').value;
  const amountRaw = document.getElementById('pAmount').value;
  const method    = document.getElementById('pMethod').value;
  const bankCode  = document.getElementById('pAccount').value;
  const rateRaw   = document.getElementById('pRateBuy').value;
  const ref       = document.getElementById('pRef').value.trim() || null;
  const note      = document.getElementById('pNote').value.trim() || null;

  if (!inv)      { toast('Pilih invoice dulu', true); return; }
  if (!date)     { toast('Tanggal wajib diisi', true); return; }
  if (!bankCode) { toast('Pilih rekening dulu (wajib untuk auto-jurnal)', true); return; }

  const isUsd  = String(inv.currency || 'IDR').toUpperCase() === 'USD';
  // USD: jumlah diisi dalam USD (sisa dihitung dalam USD oleh RPC)
  const amount = isUsd ? parseNumberUsd(amountRaw) : parseNumberId(amountRaw);
  if (!amount || amount <= 0) { toast('Jumlah tidak valid', true); return; }

  let rateBuy = null;
  if (isUsd) {
    rateBuy = parseNumberId(rateRaw);
    if (!rateBuy || rateBuy <= 0) { toast('Kurs beli wajib diisi (> 0)', true); return; }
    if (!String(bankCode).startsWith('1-112') &&
        !confirm(`Rekening ${bankCode} bukan rekening USD. Tetap simpan penerimaan USD ke rekening ini?`)) {
      return;
    }
  }

  const btn = document.getElementById('pSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';

  const payload = {
    receipt_date: date,
    currency: isUsd ? 'USD' : 'IDR',
    bank_coa_code: bankCode,
    method,
    reference_no: ref,
    note,
    allocations: [{ invoice_no: inv.invoice_no, amount }]
  };
  if (isUsd) payload.exchange_rate_buy = rateBuy;

  const { data, error } = await supabase.rpc('add_sales_receipt', { p_payload: payload });

  btn.disabled = false;
  btn.textContent = 'Simpan';

  if (error) { toast('Gagal: ' + error.message, true); return; }

  const jn = data?.journal_no ? ` · Jurnal ${data.journal_no}` : '';
  const fx = data && Math.abs(Number(data.selisih_kurs_idr || 0)) > 0.01
    ? ` · selisih kurs Rp ${fmt(data.selisih_kurs_idr)}`
    : '';
  toast('✓ Penerimaan tersimpan' + jn + fx);

  document.getElementById('pAmount').value = '';
  document.getElementById('pRef').value = '';
  document.getElementById('pNote').value = '';

  await loadPayments();
  await loadPaymentInvoices();

  // pertahankan invoice terpilih; bila sudah lunas (keluar dari daftar) form direset
  const sel = document.getElementById('pInvoice');
  if (state.selectedInvoice) {
    sel.value = String(state.selectedInvoice.id);
    if (!sel.value) {
      state.selectedInvoice = null;
      document.getElementById('paymentSummaryCard').style.display = 'none';
      document.getElementById('pRateBuyWrap').style.display = 'none';
      document.getElementById('pAmountHint').textContent = '';
      document.getElementById('pAmountLabel').textContent = 'Jumlah (IDR)';
    } else {
      await onInvoiceSelect(state.selectedInvoice.id);
    }
  }
}

async function deletePayment(paymentId, journalId) {
  const jv = journalId ? Number(journalId) : null;
  const msg = jv
    ? 'Hapus penerimaan ini? Jurnal REC-* beserta SELURUH pembayaran dalam jurnal tersebut akan dihapus dan status invoice dihitung ulang.'
    : 'Hapus pembayaran lama ini (tanpa jurnal)? Status invoice akan dihitung ulang.';
  if (!confirm(msg)) return;

  let error = null;
  if (jv) {
    const res = await supabase.rpc('delete_sales_receipt', { p_journal_id: jv });
    error = res.error;
    // Baris LAMA (add_historical_payment) memakai jurnal JV-*, bukan REC-*.
    // delete_sales_receipt menolaknya -> jatuh ke RPC lama (hapus 1 baris).
    if (error && /bukan jurnal penerimaan piutang/i.test(error.message || '')) {
      const res2 = await supabase.rpc('delete_historical_payment', { p_payment_id: paymentId });
      error = res2.error;
    }
  } else {
    const res2 = await supabase.rpc('delete_historical_payment', { p_payment_id: paymentId });
    error = res2.error;
  }

  if (error) { toast('Gagal: ' + error.message, true); return; }
  toast('✓ Pembayaran & jurnal dihapus');
  await loadPayments();
  await loadPaymentInvoices();
  if (state.selectedInvoice) {
    document.getElementById('pInvoice').value = String(state.selectedInvoice.id);
    await onInvoiceSelect(state.selectedInvoice.id);
  }
}

function bindPaymentTab() {
  const sel = document.getElementById('pInvoice');
  sel.addEventListener('change', () => onInvoiceSelect(sel.value));

  // Rekening selalu wajib: add_sales_receipt butuh bank_coa_code untuk semua metode,
  // karena setiap penerimaan membuat jurnal Dr Bank / Cr Piutang.
  document.getElementById('pAccountWrap').style.display = '';

  document.getElementById('pSaveBtn').addEventListener('click', submitPayment);

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
  document.getElementById('payResetBtn').addEventListener('click', () => {
    state.payFilters = { search:'', from:'', to:'' };
    document.getElementById('paySearch').value = '';
    document.getElementById('payFrom').value = '';
    document.getElementById('payTo').value = '';
    loadPayments();
  });

  document.getElementById('pDate').value = new Date().toISOString().slice(0,10);
}

// ============================================================
// AGING
// ============================================================
async function loadAging() {
  const tbody = document.getElementById('tbody-aging');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:16px;">Memuat...</td></tr>';
  try {
    const rows = await agingPiutang({});
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:16px;">Tidak ada piutang.</td></tr>';
      return;
    }
    let t0 = 0, t31 = 0, t60 = 0, tAll = 0;
    tbody.innerHTML = rows.map(r => {
      t0 += r.b0_30; t31 += r.b31_60; t60 += r.b60p; tAll += r.total;
      return `
        <tr>
          <td data-label="Pelanggan">${esc(r.name)}</td>
          <td data-label="0–30 hari" class="num">${fmt(r.b0_30)}</td>
          <td data-label="31–60 hari" class="num">${fmt(r.b31_60)}</td>
          <td data-label="60+ hari" class="num">${fmt(r.b60p)}</td>
          <td data-label="Total" class="num" style="font-weight:600;">${fmt(r.total)}</td>
        </tr>`;
    }).join('') + `
      <tr style="background:#f9fafb;font-weight:600;">
        <td data-label="Pelanggan">TOTAL</td>
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
// EXPORT CSV
// ============================================================
async function exportInvoices() {
  toast('Menyiapkan export invoice...');
  let q = supabase.from('historical_invoices')
    .select(`
      invoice_no, dev_date, due_date, terms_days_actual, terms_days_standard,
      currency, exchange_rate, subtotal, ppn_amount_idr, total_idr,
      partial_payment_idr, partial_payment_note,
      paid_date, paid_note, commission_idr, commission_note, commission_type,
      status, partner:partners!inner(name), sales_rep:sales_reps(code)
    `)
    .order('dev_date', { ascending: true })
    .order('invoice_no', { ascending: true });
  q = applyFilters(q);
  const { data, error } = await q;
  if (error) { toast('Gagal: ' + error.message, true); return; }

  const headers = [
    'invoice_no','partner','sales','dev_date','due_date',
    'terms_actual','terms_std','currency','exchange_rate',
    'subtotal','ppn_idr','total_idr',
    'partial_payment_idr','partial_payment_note',
    'paid_date','paid_note','commission_idr','commission_note','commission_type','status'
  ];
  const rows = (data || []).map(r => [
    r.invoice_no, r.partner?.name, r.sales_rep?.code, r.dev_date, r.due_date,
    r.terms_days_actual, r.terms_days_standard, r.currency, r.exchange_rate,
    r.subtotal, r.ppn_amount_idr, r.total_idr,
    r.partial_payment_idr, r.partial_payment_note,
    r.paid_date, r.paid_note, r.commission_idr, r.commission_note, r.commission_type, r.status
  ]);
  const ts = new Date().toISOString().slice(0,10).replace(/-/g,'');
  downloadCSV(`historical-invoices-${ts}.csv`, headers, rows);
  toast(`✓ Export ${rows.length} invoice`);
}

async function exportLines() {
  toast('Menyiapkan export line...');
  let q = supabase.from('historical_invoices')
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
      .from('historical_invoice_lines')
      .select(`
        invoice_id, line_no, display_name, qty, qty_unit,
        packaging_isi_kg, packaging_isi_ltr, total_kg, total_ltr,
        unit_price, line_total, exchange_rate, ppn_rate, ppn_amount_idr, remark,
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
    'invoice_no','partner','dev_date','currency','line_no','sku','display_name',
    'qty','qty_unit','isi_kg','isi_ltr','total_kg','total_ltr',
    'unit_price','line_total','exchange_rate','ppn_rate','ppn_idr','remark'
  ];
  const rows = allLines.map(l => {
    const inv = invMap[l.invoice_id] || {};
    return [
      inv.invoice_no, inv.partner?.name, inv.dev_date, inv.currency,
      l.line_no, l.item?.sku, l.display_name || l.item?.name,
      l.qty, l.qty_unit,
      l.packaging_isi_kg, l.packaging_isi_ltr, l.total_kg, l.total_ltr,
      l.unit_price, l.line_total, l.exchange_rate, l.ppn_rate, l.ppn_amount_idr, l.remark
    ];
  });
  const ts = new Date().toISOString().slice(0,10).replace(/-/g,'');
  downloadCSV(`historical-lines-${ts}.csv`, headers, rows);
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
  bind('fSales', 'sales_rep_id');
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
    state.filters = { search:'', partner_id:'', sales_rep_id:'', status:'', currency:'', from:'', to:'' };
    ['fSearch','fPartner','fSales','fStatus','fCurrency','fFrom','fTo'].forEach(id => {
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

  const role = await requirePageAccess('piutang');
  if (!role) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('roleBadge').textContent = `(${role})`;

  await preloadPermissions();
  await renderNav(document.getElementById('mainNav'), 'piutang');

  state.canViewInvoice   = await hasPermission('historical.view');
  state.canViewAging     = await hasPermission('reports.aging_piutang');
  state.canExport        = await hasPermission('historical.export');
  state.canViewPayment   = await hasPermission('historical.view');
  state.canCreatePayment = await hasPermission('historical.payment.create');
  state.canDeletePayment = await hasPermission('historical.payment.delete');

  const tabPerms = {
    invoice: state.canViewInvoice,
    payment: state.canViewPayment,
    aging:   state.canViewAging
  };
  let firstAllowed = null;
  document.querySelectorAll('.tabs button').forEach(btn => {
    const tab = btn.dataset.tab;
    if (tab === 'commission') {
      if (!firstAllowed) firstAllowed = tab;
      return;
    }
    if (tabPerms[tab] === false) btn.style.display = 'none';
    else if (tabPerms[tab] === true && !firstAllowed) firstAllowed = tab;
  });

  if (!firstAllowed) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#dc2626;">Anda tidak punya akses ke tab mana pun di halaman ini.</div>';
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
  else if (state.activeTab === 'payment' && state.canViewPayment) {
    await loadPaymentInvoices();
    state.paymentsLoaded = true;
    await loadPayments();
  }
})();