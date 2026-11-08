// js/historical-page.js
import { supabase } from './supabase-client.js';
import { requireAuth, getCurrentRole, logout } from './auth.js';
import { hasPermission } from './permissions.js';

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
  page: 1,
  filters: { search: '', partner_id: '', sales_rep_id: '', status: '', currency: '', from: '', to: '' },
  total: 0,
  canExport: false
};

// ============================================================
// NAV (simple — samakan dengan halaman lain)
// ============================================================
function renderNav() {
  const nav = document.getElementById('mainNav');
  const items = [
    { href: './dashboard.html', label: 'Dashboard' },
    { href: './inventory.html', label: 'Inventory' },
    { href: './sales-order.html', label: 'Sales Order' },
    { href: './delivery.html', label: 'Delivery' },
    { href: './historical.html', label: 'Historis', active: true },
    { href: './approval.html', label: 'Approval' },
    { href: './permissions.html', label: 'Permission' }
  ];
  nav.innerHTML = items.map(i =>
    `<a href="${i.href}" class="${i.active ? 'active' : ''}">${esc(i.label)}</a>`
  ).join('');
}

// ============================================================
// FILTER OPTIONS
// ============================================================
async function loadFilterOptions() {
  // Partner (yang punya invoice historis)
  const { data: partners, error: pErr } = await supabase
    .from('partners')
    .select('id, name')
    .order('name');
  if (pErr) { console.warn(pErr); }
  const selP = document.getElementById('fPartner');
  (partners || []).forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    selP.appendChild(opt);
  });

  // Sales
  const { data: reps, error: rErr } = await supabase
    .from('sales_reps')
    .select('id, code, name')
    .order('code');
  if (rErr) { console.warn(rErr); }
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
// SUMMARY (dari filter aktif — hitung di client dari semua data? tidak)
// ============================================================
// Supabase tidak bisa SUM langsung via select. Kita ambil agregat via RPC
// atau hitung dari semua baris (max 307 invoice, masih ringan).
// Untuk sederhana: hitung dari filter tanpa pagination — pakai query terpisah
// yang hanya select kolom yang dibutuhkan (tanpa join) untuk efisiensi.
async function loadSummary() {
  // Ambil semua subtotal/ppn/total sesuai filter (tanpa pagination)
  let q = supabase
    .from('historical_invoices')
    .select('subtotal, ppn_amount_idr, total_idr, currency', { count: 'exact' });

  // Filter sederhana (tanpa search partner karena butuh join; kita pakai filter invoice_no saja)
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

  // Nomor halaman (maks 7 tombol)
  const start = Math.max(1, state.page - 3);
  const end = Math.min(totalPages, state.page + 3);
  for (let i = start; i <= end; i++) {
    html += btn(String(i), i, false, i === state.page);
  }
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
    .from('historical_invoices')
    .select(`
      *, partner:partners!inner(id, name),
      sales_rep:sales_reps(id, code)
    `)
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
    .select(`
      *, item:items!inner(sku, name, nama_jual)
    `)
    .eq('invoice_id', invoiceId)
    .order('line_no');

  if (e2) {
    linesEl.innerHTML = `<tr><td colspan="9" style="color:#dc2626;">Error: ${esc(e2.message)}</td></tr>`;
    return;
  }

  if (!lines || !lines.length) {
    linesEl.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#9ca3af;padding:8px;">Tidak ada line.</td></tr>';
    return;
  }

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

function closeDetail() {
  document.getElementById('detailModal').style.display = 'none';
}

// ============================================================
// EXPORT CSV
// ============================================================
async function exportInvoices() {
  toast('Menyiapkan export invoice...');

  let q = supabase
    .from('historical_invoices')
    .select(`
      invoice_no, dev_date, due_date, terms_days_actual, terms_days_standard,
      currency, exchange_rate, subtotal, ppn_amount_idr, total_idr,
      partial_payment_idr, partial_payment_note,
      paid_date, paid_note, commission_idr, commission_note, commission_type,
      status,
      partner:partners!inner(name),
      sales_rep:sales_reps(code)
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

  // Ambil semua invoice id sesuai filter, lalu ambil line
  let q = supabase
    .from('historical_invoices')
    .select('id, invoice_no, dev_date, currency, partner:partners!inner(name)')
    .order('dev_date', { ascending: true });
  q = applyFilters(q);
  const { data: invs, error: e1 } = await q;
  if (e1) { toast('Gagal: ' + e1.message, true); return; }

  if (!invs || !invs.length) { toast('Tidak ada data'); return; }

  const ids = invs.map(i => i.id);
  // Chunk agar tidak kena limit URL
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
      .order('invoice_id')
      .order('line_no');
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
// BIND FILTER
// ============================================================
function bindFilters() {
  const bind = (id, key, evt = 'change') => {
    document.getElementById(id).addEventListener(evt, () => {
      state.filters[key] = document.getElementById(id).value;
      state.page = 1;
      loadInvoices();
    });
  };
  bind('fSearch', 'search', 'input');
  bind('fPartner', 'partner_id');
  bind('fSales', 'sales_rep_id');
  bind('fStatus', 'status');
  bind('fCurrency', 'currency');
  bind('fFrom', 'from');
  bind('fTo', 'to');

  document.getElementById('fResetBtn').addEventListener('click', () => {
    state.filters = { search:'', partner_id:'', sales_rep_id:'', status:'', currency:'', from:'', to:'' };
    ['fSearch','fPartner','fSales','fStatus','fCurrency','fFrom','fTo'].forEach(id => {
      document.getElementById(id).value = '';
    });
    state.page = 1;
    loadInvoices();
  });

  // Debounce search
  let timer;
  document.getElementById('fSearch').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.filters.search = document.getElementById('fSearch').value;
      state.page = 1;
      loadInvoices();
    }, 350);
  });
}

// ============================================================
// INIT
// ============================================================
async function init() {
  const user = await requireAuth();
  if (!user) return;

  // Permission gate
  const canView = await hasPermission('historical.view');
  if (!canView) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#dc2626;">Anda tidak punya akses ke halaman ini.</div>';
    return;
  }
  state.canExport = await hasPermission('historical.export');
  document.getElementById('exportInvBtn').style.display = state.canExport ? 'inline-block' : 'none';
  document.getElementById('exportLineBtn').style.display = state.canExport ? 'inline-block' : 'none';

  renderNav();
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('exportInvBtn').addEventListener('click', exportInvoices);
  document.getElementById('exportLineBtn').addEventListener('click', exportLines);
  document.getElementById('detailCloseBtn').addEventListener('click', closeDetail);
  document.getElementById('detailModal').addEventListener('click', (e) => {
    if (e.target.id === 'detailModal') closeDetail();
  });

  bindFilters();
  await loadFilterOptions();
  await loadInvoices();
}

init();