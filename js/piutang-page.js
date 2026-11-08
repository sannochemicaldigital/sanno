// js/piutang-page.js
import { supabase } from './supabase-client.js';
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission, preloadPermissions } from './permissions.js';
import { agingPiutang } from './reports.js';

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
      <td style="font-family:monospace;font-size:12px;">${esc(r.invoice_no)}</td>
      <td>${esc(r.partner?.name || '—')}</td>
      <td>${esc(r.sales_rep?.code || '—')}</td>
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
          <td>${l.line_no}</td>
          <td style="font-family:monospace;font-size:12px;">${esc(l.item?.sku || '—')}</td>
          <td>${esc(l.display_name || l.item?.name || '—')}</td>
          <td class="num">${fmtInt(l.qty)}</td>
          <td class="num">${isi}</td>
          <td class="num">${fmt(l.unit_price)}</td>
          <td class="num">${fmt(l.line_total)}</td>
          <td class="num">${fmt(l.ppn_amount_idr)}</td>
          <td style="font-size:12px;color:#6b7280;">${esc(l.remark || '')}</td>
        </tr>
      `;
    }).join('');
  }

  // Section Pembayaran
  const { data: pays, error: e3 } = await supabase
    .from('historical_invoice_payments')
    .select(`id, payment_date, amount_idr, method, reference_no, note, created_at, created_by, account:accounts(code, name)`)
    .eq('invoice_id', invoiceId)
    .order('payment_date', { ascending: true })
    .order('id', { ascending: true });

  if (!e3 && pays && pays.length) {
    paySection.style.display = 'block';
    const totalManual = pays.reduce((s, p) => s + Number(p.amount_idr || 0), 0);
    const partial = Number(inv.partial_payment_idr || 0);
    const totalPaid = partial + totalManual;
    const sisa = Number(inv.total_idr || 0) - totalPaid;

    payBody.innerHTML = pays.map(p => `
      <tr>
        <td>${fmtDate(p.payment_date)}</td>
        <td class="num">${fmt(p.amount_idr)}</td>
        <td>${esc(p.method)}</td>
        <td style="font-size:12px;">${esc(p.account?.code || '')} ${esc(p.account?.name || '')}</td>
        <td style="font-size:12px;">${esc(p.reference_no || '')}</td>
        <td style="font-size:12px;">${esc(p.note || '')}</td>
        <td style="font-size:11px;color:#6b7280;">${p.created_at ? new Date(p.created_at).toLocaleString('id-ID') : '—'}</td>
      </tr>
    `).join('');

    paySummary.innerHTML = `
      <div style="display:flex;gap:16px;flex-wrap:wrap;background:#f9fafb;padding:10px 12px;border-radius:8px;">
        <div><span style="color:#6b7280;">Total dibayar:</span> <strong>${fmt(totalPaid)}</strong></div>
        <div><span style="color:#6b7280;">Excel (Titip):</span> ${fmt(partial)}</div>
        <div><span style="color:#6b7280;">Manual:</span> ${fmt(totalManual)}</div>
        <div><span style="color:#6b7280;">Sisa:</span> <strong style="color:${sisa > 0 ? '#dc2626' : '#059669'};">${fmt(sisa)}</strong></div>
      </div>
    `;
  } else if (pays && pays.length === 0) {
    const partial = Number(inv.partial_payment_idr || 0);
    if (partial > 0) {
      paySection.style.display = 'block';
      payBody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:8px;">Belum ada pembayaran manual (hanya titip Excel).</td></tr>';
      paySummary.innerHTML = `<div style="background:#f9fafb;padding:10px 12px;border-radius:8px;">
        <span style="color:#6b7280;">Excel (Titip):</span> <strong>${fmt(partial)}</strong> ·
        <span style="color:#6b7280;">Sisa:</span> <strong style="color:#dc2626;">${fmt(Number(inv.total_idr||0) - partial)}</strong>
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
      `<option value="${a.id}">${esc(a.code)} — ${esc(a.name)}</option>`
    ).join('');
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
    .select(`id, invoice_no, total_idr, partial_payment_idr, manual_payment_idr, status, partner:partners!inner(name)`)
    .eq('id', invoiceId)
    .single();
  if (error) { toast('Gagal memuat invoice: ' + error.message, true); return; }
  state.selectedInvoice = inv;

  const total = Number(inv.total_idr || 0);
  const partial = Number(inv.partial_payment_idr || 0);
  const manual = Number(inv.manual_payment_idr || 0);
  const sisa = total - partial - manual;

  document.getElementById('psInvNo').textContent = inv.invoice_no;
  document.getElementById('psPartner').textContent = inv.partner?.name || '';
  document.getElementById('psTotal').textContent = 'Rp ' + fmt(total);
  document.getElementById('psPartial').textContent = 'Rp ' + fmt(partial);
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
    .from('historical_invoice_payments')
    .select(`
      id, payment_date, amount_idr, method, reference_no, note, created_at, journal_id,
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
  renderPaymentsTable(data || []);
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
      <td style="font-family:monospace;font-size:12px;">${esc(r.invoice?.invoice_no || '—')}</td>
      <td>${esc(r.invoice?.partner?.name || '—')}</td>
      <td>${fmtDate(r.payment_date)}</td>
      <td class="num" style="font-weight:600;">${fmt(r.amount_idr)}</td>
      <td>${esc(r.method)}</td>
      <td style="font-size:12px;">${esc(r.account?.code || '')} ${esc(r.account?.name || '')}</td>
      <td style="font-size:12px;">${esc(r.reference_no || '')}</td>
      <td style="font-size:11px;color:#6b7280;">${r.created_at ? new Date(r.created_at).toLocaleString('id-ID') : '—'}</td>
      <td style="font-size:11px;">${r.journal_id ? `<span style="background:#dbeafe;color:#1e40af;padding:2px 6px;border-radius:4px;">JV</span>` : '—'}</td>
      <td>
        ${state.canDeletePayment
          ? `<button type="button" class="btn btn-danger" data-del-pay="${r.id}" style="padding:4px 10px;font-size:12px;">Hapus</button>`
          : '—'}
      </td>
    </tr>
  `).join('');

  document.getElementById('payTotalInfo').textContent =
    `Menampilkan ${rows.length} pembayaran · Total: Rp ${fmt(total)}`;

  tbody.querySelectorAll('button[data-del-pay]').forEach(btn => {
    btn.addEventListener('click', () => deletePayment(Number(btn.dataset.delPay)));
  });
}

async function submitPayment() {
  const invoiceId  = document.getElementById('pInvoice').value;
  const date       = document.getElementById('pDate').value;
  const amountRaw  = document.getElementById('pAmount').value;
  const method     = document.getElementById('pMethod').value;
  const accountId  = document.getElementById('pAccount').value;
  const ref        = document.getElementById('pRef').value.trim() || null;
  const note       = document.getElementById('pNote').value.trim() || null;

  if (!invoiceId) { toast('Pilih invoice dulu', true); return; }
  if (!date)      { toast('Tanggal wajib diisi', true); return; }
  const amount = parseNumberId(amountRaw);
  if (!amount || amount <= 0) { toast('Jumlah tidak valid', true); return; }
  if (['transfer','cash','giro'].includes(method) && !accountId) {
    toast('Pilih rekening dulu (untuk auto-jurnal)', true); return;
  }

  const btn = document.getElementById('pSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';

  const { data, error } = await supabase.rpc('add_historical_payment', {
    p_invoice_id: Number(invoiceId),
    p_payment_date: date,
    p_amount_idr: amount,
    p_method: method,
    p_reference_no: ref,
    p_note: note,
    p_account_id: accountId ? Number(accountId) : null
  });

  btn.disabled = false;
  btn.textContent = 'Simpan';

  if (error) { toast('Gagal: ' + error.message, true); return; }

  const jn = data?.journal_no ? ` · Jurnal ${data.journal_no}` : '';
  toast('✓ Pembayaran tersimpan' + jn);

  document.getElementById('pAmount').value = '';
  document.getElementById('pRef').value = '';
  document.getElementById('pNote').value = '';
  document.getElementById('pAccount').value = '';

  if (state.selectedInvoice) {
    await onInvoiceSelect(state.selectedInvoice.id);
  }
  await loadPayments();
  await loadPaymentInvoices();
}

async function deletePayment(paymentId) {
  if (!confirm('Hapus pembayaran ini? Jurnal terkait juga akan dihapus & status invoice dihitung ulang.')) return;
  const { error } = await supabase.rpc('delete_historical_payment', { p_payment_id: paymentId });
  if (error) { toast('Gagal: ' + error.message, true); return; }
  toast('✓ Pembayaran & jurnal dihapus');
  await loadPayments();
  await loadPaymentInvoices();
  if (state.selectedInvoice) {
    await onInvoiceSelect(state.selectedInvoice.id);
  }
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