// js/inventory-page.js
import './input-clear.js';
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission } from './permissions.js';
import { listItems, createItem } from './items.js';
import { supabase } from './supabase-client.js';
import { listUnits, createUnit, updateUnit, deleteUnit, reactivateUnit } from './units.js';

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
  return Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function fmtDateTime(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('id-ID'); } catch { return esc(ts); }
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
function reasonLabel(r) {
  return ({ rusak:'Rusak', hilang:'Hilang', salah_input:'Salah input', lainnya:'Lainnya' })[r] || (r || '—');
}

let allItems = [];
let inventoryRows = [];
let allUnits = [];          // cache daftar unit (untuk dropdown)
const perms = {
  create: false, stockIn: false, viewPrice: false, viewMovement: false,
  stockAdjust: false,
  opnameView: false, opnameCreate: false, opnameApprove: false,
  priceListView: false, priceListManage: false
};
const invFilter = {
  search: '',
  onlyReserved: false,
  onlyLowStock: false
};
function renderJournalBadge(r) {
  if (!r.needs_journal) {
    return '<span style="color:#9ca3af;">—</span>';
  }
  if (r.journal_entry_id != null) {
    const tgl = r.journal_posted_at ? new Date(r.journal_posted_at).toLocaleDateString('id-ID') : '';
    return `<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px;">Sudah${tgl ? ' · ' + esc(tgl) : ''}</span>`;
  }
  return '<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px;">Belum dijurnal</span>';
}

// ---------- state tab koreksi stok (Phase 1) ----------
let stockAdjustInitialized = false;
let allItemsForAdjust = [];
const adjustFilter = { search: '', from: '', to: '', onlyUnjournaled: false };
const ADJUST_LIMIT = 50;
let adjustOffset = 0;
let adjustReqSeq = 0;
let adjustRowsCache = [];
let adjustTotalCount = 0;

// ---------- state tab opname massal (Phase 2) ----------
let opnameInitialized = false;
let currentOpnameId = null;
let opnameLinesCache = [];        // cache full lines utk filter client-side
let currentOpnameStatus = '';
const opnameFilter = { search: '', onlyDelta: false, lineOffset: 0 };
const OPNAME_LINE_LIMIT = 200;
let opnameLineReqSeq = 0;
const opnameHistFilter = { search: '', status: '', from: '', to: '' };
const OPNAME_HIST_LIMIT = 50;
let opnameHistOffset = 0;
let opnameHistReqSeq = 0;

// ---------- state tab price list (Phase 3) ----------
let priceListInitialized = false;
let priceListRowsCache = [];
const priceListFilter = { search: '', onlyWithPrice: false };
const PRICE_LIST_LIMIT = 200;
let priceListOffset = 0;
let priceListTotalCount = 0;
let priceListReqSeq = 0;
let priceListDirty = new Set();     // item_id yang berubah
const priceListHistFilter = { search: '', itemId: null };
const PRICE_LIST_HIST_LIMIT = 100;
let priceListHistOffset = 0;
let priceListHistTotalCount = 0;
let priceListHistReqSeq = 0;

(async () => {
  const user = await requireAuth();
  if (!user) return;

  const role = await requirePageAccess('inventory');
  if (!role) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  await renderNav(document.getElementById('mainNav'), 'inventory');

  perms.create       = await hasPermission('inventory.item.create');
  perms.stockIn      = await hasPermission('inventory.stock_in');
  perms.viewPrice    = await hasPermission('inventory.item.view_price');
  perms.viewMovement = await hasPermission('inventory.movement.view');
  perms.stockAdjust  = await hasPermission('inventory.stock_adjust');
  perms.opnameView   = await hasPermission('inventory.opname.view');
  perms.opnameCreate = await hasPermission('inventory.opname.create');
  perms.opnameApprove= await hasPermission('inventory.opname.approve');
  perms.priceListView   = await hasPermission('inventory.price_list.view');
  perms.priceListManage = await hasPermission('inventory.price_list.manage');

  if (!perms.create)  document.getElementById('form-new-item').style.display = 'none';
  if (!perms.stockIn) document.getElementById('form-stock-in').style.display = 'none';
  if (!perms.viewMovement) {
    const histCard = document.getElementById('tbody-movements')?.closest('.card');
    if (histCard) histCard.style.display = 'none';
  }

  // Sembunyikan tab Price List kalau tidak punya permission view
  if (!perms.priceListView) {
    const plTabBtn = document.querySelector('.tabs button[data-tab="pricelist"]');
    if (plTabBtn) plTabBtn.style.display = 'none';
  }

  const stockInDate = document.querySelector('#form-stock-in [name=movement_date]');
  if (stockInDate) stockInDate.value = todayISO();

  if (perms.create)  document.getElementById('form-new-item').addEventListener('submit', onCreateItem);
  if (perms.stockIn) document.getElementById('form-stock-in').addEventListener('submit', onStockIn);

  // Tab switcher (lazy-init per tab)
  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      const panel = document.getElementById('tab-' + btn.dataset.tab);
      if (panel) panel.style.display = 'block';

      if (btn.dataset.tab === 'adjust' && !stockAdjustInitialized) {
        stockAdjustInitialized = true;
        try { await initStockAdjustTab(); }
        catch (err) {
          document.getElementById('tbody-stock-adjust').innerHTML =
            `<tr><td colspan="10" style="color:#b91c1c;">Gagal memuat: ${esc(err.message)}</td></tr>`;
        }
      }

      if (btn.dataset.tab === 'opname' && !opnameInitialized) {
        opnameInitialized = true;
        try { await initOpnameTab(); }
        catch (err) {
          const el = document.getElementById('tbody-opname-lines');
          if (el) el.innerHTML = `<tr><td colspan="8" style="color:#b91c1c;">Gagal memuat: ${esc(err.message)}</td></tr>`;
        }
      }

      if (btn.dataset.tab === 'pricelist' && !priceListInitialized) {
        priceListInitialized = true;
        try { await initPriceListTab(); }
        catch (err) {
          const el = document.getElementById('tbody-price-list');
          if (el) el.innerHTML = `<tr><td colspan="9" style="color:#b91c1c;">Gagal memuat: ${esc(err.message)}</td></tr>`;
        }
      }
    });
  });

  bindInventoryFilters();
  await loadUnitsAndFillDropdown();
  wireUnitsModal();
  await loadAll();
})();
// ---------- filter binding ----------
function bindInventoryFilters() {
  const inpSearch = document.getElementById('invSearch');
  const chkReserved = document.getElementById('invOnlyReserved');
  const chkLow = document.getElementById('invOnlyLowStock');

  if (inpSearch) {
    let t = null;
    inpSearch.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        invFilter.search = inpSearch.value.trim();
        await renderInventory();
      }, 300);
    });
  }
  if (chkReserved) {
    chkReserved.addEventListener('change', async () => {
      invFilter.onlyReserved = chkReserved.checked;
      await renderInventory();
    });
  }
  if (chkLow) {
    chkLow.addEventListener('change', () => {
      invFilter.onlyLowStock = chkLow.checked;
      renderInventoryTable();
    });
  }
}

async function loadAll() {
  const tasks = [renderInventory(), loadItemsForDropdown()];
  if (perms.viewMovement) tasks.push(renderMovements());
  await Promise.all(tasks);
}

// ---------- RPC: inventory dengan reservasi ----------
async function rpcInventory() {
  const { data, error } = await supabase.rpc('get_inventory_with_reservation', {
    p_search: invFilter.search || null,
    p_only_reserved: invFilter.onlyReserved,
    p_limit: 500,
    p_offset: 0
  });
  if (error) throw error;
  return data || [];
}

async function renderInventory() {
  const tbody = document.getElementById('tbody-inventory');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  try {
    inventoryRows = await rpcInventory();
    renderInventoryTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

function renderInventoryTable() {
  const tbody = document.getElementById('tbody-inventory');
  if (!tbody) return;

  let rows = inventoryRows;
  if (invFilter.onlyLowStock) rows = rows.filter(r => r.is_low_stock);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#9ca3af;">Tidak ada item cocok</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(i => {
    const stock = Number(i.stock_qty);
    const reserved = Number(i.reserved_qty);
    const available = Number(i.available_qty);
    const min = Number(i.min_stock);

    let statusHtml;
    if (stock === 0) statusHtml = '<span style="color:#b91c1c;font-weight:600;">KOSONG</span>';
    else if (i.is_low_stock) statusHtml = '<span style="color:#b45309;font-weight:600;">RENDAH</span>';
    else statusHtml = '<span style="color:#059669;">OK</span>';

    const reservedHtml = reserved > 0
      ? `<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:4px;font-weight:600;">${fmt(reserved)}</span>`
      : `<span style="color:#9ca3af;">0</span>`;

    const availableHtml = i.is_low_stock
      ? `<span style="color:#b45309;font-weight:600;">${fmt(available)}</span>`
      : fmt(available);

    return `
      <tr>
        <td data-label="SKU">${esc(i.sku)}</td>
        <td data-label="Nama">${esc(i.name)}</td>
        <td data-label="Satuan">${esc(i.unit)}</td>
        <td data-label="Stok" class="num">${fmt(stock)}</td>
        <td data-label="Reserved" class="num">${reservedHtml}</td>
        <td data-label="Available" class="num">${availableHtml}</td>
        <td data-label="Min" class="num">${fmt(min)}</td>
        <td data-label="Status">${statusHtml}</td>
      </tr>`;
  }).join('');
}

// ---------- dropdown stok masuk ----------
async function loadItemsForDropdown() {
  if (!perms.stockIn) return;
  try {
    allItems = await listItems();
    const sel = document.getElementById('stockInItem');
    if (!sel) return;
    sel.innerHTML = '<option value="">— pilih item —</option>' +
      allItems.map(i =>
        `<option value="${i.id}">${esc(i.sku)} — ${esc(i.name)} (stok: ${Number(i.stock_qty).toLocaleString('id-ID')})</option>`
      ).join('');
  } catch (err) {
    console.error('loadItemsForDropdown:', err);
  }
}

// ---------- movements (riwayat mutasi stok) ----------
async function renderMovements() {
  const tbody = document.getElementById('tbody-movements');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  try {
    const { data, error } = await supabase
      .from('stock_movements')
      .select('id, movement_date, type, qty, unit_cost, total_cost, memo, items!inner(sku, name)')
      .order('movement_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(100);
    if (error) throw error;

    tbody.innerHTML = (data || []).map(m => {
      const priceCols = perms.viewPrice
        ? `<td data-label="Harga" class="num">${fmt(m.unit_cost)}</td>
           <td data-label="Total" class="num">${fmt(m.total_cost)}</td>`
        : `<td data-label="Harga" class="num">—</td>
           <td data-label="Total" class="num">—</td>`;

      const typeLabel = m.type === 'in' ? 'Masuk'
                      : m.type === 'out' ? 'Keluar'
                      : m.type === 'adjust' ? 'Koreksi'
                      : m.type;
      const typeColor = m.type === 'in' ? '#059669'
                      : m.type === 'out' ? '#b91c1c'
                      : '#6b7280';

      return `
        <tr>
          <td data-label="Tanggal">${esc(m.movement_date)}</td>
          <td data-label="Item">${esc(m.items?.sku || '')} — ${esc(m.items?.name || '')}</td>
          <td data-label="Tipe"><span style="color:${typeColor};font-weight:600;">${esc(typeLabel)}</span></td>
          <td data-label="Qty" class="num">${fmt(m.qty)}</td>
          ${priceCols}
          <td data-label="Memo">${esc(m.memo || '—')}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Belum ada mutasi stok</td></tr>';
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

// ---------- form handlers ----------
async function onCreateItem(e) {
  e.preventDefault();
  if (!perms.create) { toast('Tidak ada akses buat item', true); return; }
  const f = e.target;
  const btn = document.getElementById('createItemBtn');
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  try {
    const unitVal = (f.unit.value || '').trim();
    if (!unitVal) throw new Error('Satuan wajib dipilih');
    await createItem({
      sku: f.sku.value.trim(),
      name: f.name.value.trim(),
      unit: unitVal,
      min_stock: Number(f.min_stock.value) || 0
    });
    toast('✓ Item baru dibuat (stok 0)');
    f.reset();
    // Reset dropdown ke pilihan default (pcs kalau ada, else kosong)
    const pcsOpt = [...f.unit.options].find(o => o.value === 'pcs');
    f.unit.value = pcsOpt ? 'pcs' : '';
    f.min_stock.value = 0;
    await loadAll();
  } catch (err) {
    toast('Gagal: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan Item';
  }
}

async function onStockIn(e) {
  e.preventDefault();
  if (!perms.stockIn) { toast('Tidak ada akses stok masuk', true); return; }
  const f = e.target;
  const btn = document.getElementById('stockInBtn');
  btn.disabled = true;
  btn.textContent = 'Menambah...';
  try {
    const { error } = await supabase.rpc('add_stock_in', {
      p_item_id: Number(f.item_id.value),
      p_qty: Number(f.qty.value),
      p_unit_cost: Number(f.unit_cost.value),
      p_movement_date: f.movement_date.value,
      p_memo: f.memo.value.trim() || null
    });
    if (error) throw error;
    toast('✓ Stok berhasil ditambahkan');
    f.qty.value = '';
    f.unit_cost.value = '';
    f.memo.value = '';
    await loadAll();
  } catch (err) {
    toast('Gagal: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Tambah Stok';
  }
}

// ============================================================
// TAB KOREKSI STOK (Phase 1)
// ============================================================
async function initStockAdjustTab() {
  const formCard = document.getElementById('stock-adjust-form-card');
  if (!perms.stockAdjust && formCard) formCard.style.display = 'none';

  const dateEl = document.getElementById('saDate');
  if (dateEl) {
    dateEl.value = todayISO();
    dateEl.max = todayISO();
  }

  await loadItemsForAdjust();
  if (perms.stockAdjust) wireStockAdjustForm();
  wireStockAdjustHistory();
  await reloadStockAdjust();
}

async function loadItemsForAdjust() {
  const sel = document.getElementById('saItemId');
  if (!sel) return;
  try {
    allItemsForAdjust = await listItems();
    sel.innerHTML = '<option value="">— pilih item —</option>' +
      allItemsForAdjust
        .filter(i => i.is_active !== false)
        .map(i => `<option value="${i.id}">${esc(i.sku)} — ${esc(i.name)}</option>`)
        .join('');
  } catch (err) {
    console.error('loadItemsForAdjust:', err);
    toast('Gagal memuat daftar item: ' + (err.message || err), true);
  }
}

function wireStockAdjustForm() {
  const form = document.getElementById('form-stock-adjust');
  if (!form) return;
  const selItem = document.getElementById('saItemId');
  const qtySystem = document.getElementById('saQtySystem');
  const qtyAfter = document.getElementById('saQtyAfter');
  const deltaEl = document.getElementById('saDelta');
  const btn = document.getElementById('saSubmitBtn');

  const recompute = () => {
    const itemId = Number(selItem.value);
    const item = allItemsForAdjust.find(i => Number(i.id) === itemId);
    const sys = item ? Number(item.stock_qty) : 0;
    qtySystem.value = item ? fmt(sys) : '';
    const afterRaw = qtyAfter.value;
    if (afterRaw === '' || itemId === 0) {
      deltaEl.value = '';
      btn.disabled = true;
      return;
    }
    const after = Number(afterRaw);
    const delta = after - sys;
    deltaEl.value = (delta > 0 ? '+' : '') + fmt(delta);
    deltaEl.style.color = delta === 0 ? '#6b7280' : (delta > 0 ? '#059669' : '#b91c1c');
    btn.disabled = (delta === 0)
      || !document.getElementById('saReason').value
      || !document.getElementById('saDate').value;
  };

  selItem.addEventListener('change', recompute);
  qtyAfter.addEventListener('input', recompute);
  document.getElementById('saReason').addEventListener('change', recompute);
  document.getElementById('saDate').addEventListener('change', recompute);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!perms.stockAdjust) { toast('Tidak ada akses koreksi stok', true); return; }
    btn.disabled = true;
    btn.textContent = 'Menyimpan...';
    try {
      const { data, error } = await supabase.rpc('adjust_stock_item', {
        p_item_id:     Number(selItem.value),
        p_qty_after:   Number(qtyAfter.value),
        p_reason:      document.getElementById('saReason').value,
        p_memo:        document.getElementById('saMemo').value.trim() || null,
        p_adjust_date: document.getElementById('saDate').value
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const d = Number(row?.qty_delta ?? 0);
      toast(`✓ Stok dikoreksi (${d > 0 ? '+' : ''}${fmt(d)})`);

      form.reset();
      document.getElementById('saMemo').value = '';
      document.getElementById('saQtySystem').value = '';
      document.getElementById('saDelta').value = '';
      document.getElementById('saDate').value = todayISO();
      btn.disabled = true;

      await Promise.all([reloadStockAdjust(), renderInventory()]);
    } catch (err) {
      toast('Gagal koreksi: ' + (err.message || err), true);
    } finally {
      btn.textContent = 'Koreksi Stok';
    }
  });
}

function wireStockAdjustHistory() {
  const inpSearch = document.getElementById('saSearch');
  const fromEl = document.getElementById('saFrom');
  const toEl = document.getElementById('saTo');
  const chkUnjournaled = document.getElementById('saOnlyUnjournaled');
  const refreshBtn = document.getElementById('saRefreshBtn');
  const moreBtn = document.getElementById('saMoreBtn');

  if (inpSearch) {
    let t = null;
    inpSearch.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        adjustFilter.search = inpSearch.value.trim();
        await reloadStockAdjust();
      }, 300);
    });
  }
  if (fromEl) fromEl.addEventListener('change', async () => { adjustFilter.from = fromEl.value; await reloadStockAdjust(); });
  if (toEl)   toEl.addEventListener('change',   async () => { adjustFilter.to   = toEl.value;   await reloadStockAdjust(); });
    if (chkUnjournaled) chkUnjournaled.addEventListener('change', () => {
    adjustFilter.onlyUnjournaled = chkUnjournaled.checked;
    renderStockAdjustRows(adjustTotalCount);
  });
  if (refreshBtn) refreshBtn.addEventListener('click', () => reloadStockAdjust());
  if (moreBtn)    moreBtn.addEventListener('click', () => loadStockAdjust(true));
}

async function reloadStockAdjust() {
  adjustOffset = 0;
  const tbody = document.getElementById('tbody-stock-adjust');
  if (tbody) tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  const moreBtn = document.getElementById('saMoreBtn');
  if (moreBtn) moreBtn.style.display = 'none';
  const info = document.getElementById('saInfo');
  if (info) info.textContent = '';
  adjustRowsCache = [];
  await loadStockAdjust(false);
}

async function loadStockAdjust(append = false) {
  const tbody = document.getElementById('tbody-stock-adjust');
  if (!tbody) return;
  if (!append) tbody.innerHTML = '';
  const seq = ++adjustReqSeq;
  try {
    const { data, error } = await supabase.rpc('list_stock_adjustments', {
      p_search: adjustFilter.search || null,
      p_from:   adjustFilter.from   || null,
      p_to:     adjustFilter.to     || null,
      p_limit:  ADJUST_LIMIT,
      p_offset: adjustOffset
    });
    if (error) throw error;
    if (seq !== adjustReqSeq) return;

    const rows = data || [];
    const totalCount = rows[0]?.total_count != null ? Number(rows[0].total_count) : rows.length;

        if (append) adjustRowsCache = adjustRowsCache.concat(rows);
    else adjustRowsCache = rows;

    adjustTotalCount = totalCount;
    adjustOffset += rows.length;
    renderStockAdjustRows(totalCount);
  } catch (err) {
    tbody.innerHTML += `<tr><td colspan="11" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

function renderStockAdjustRows(totalCount) {
  const tbody = document.getElementById('tbody-stock-adjust');
  if (!tbody) return;

  let rows = adjustRowsCache;
  if (adjustFilter.onlyUnjournaled) {
    rows = rows.filter(r => r.needs_journal === true && r.journal_entry_id == null);
  }

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:#9ca3af;">Belum ada koreksi stok</td></tr>';
  } else {
    tbody.innerHTML = rows.map(r => {
      const d = Number(r.qty_delta);
      const dStr = (d > 0 ? '+' : '') + fmt(d);
      const dColor = d > 0 ? '#059669' : '#b91c1c';
      const journalBadge = renderJournalBadge(r);
      return `
        <tr>
          <td data-label="Tanggal" style="white-space:nowrap;">${esc(r.adjust_date)}</td>
          <td data-label="SKU">${esc(r.sku)}</td>
          <td data-label="Item">${esc(r.item_name)}</td>
          <td data-label="Satuan">${esc(r.unit)}</td>
          <td data-label="Sebelum" class="num">${fmt(r.qty_before)}</td>
          <td data-label="Sesudah" class="num">${fmt(r.qty_after)}</td>
          <td data-label="Delta" class="num" style="color:${dColor};font-weight:600;">${dStr}</td>
          <td data-label="Alasan">${esc(reasonLabel(r.reason))}</td>
          <td data-label="Memo">${esc(r.memo || '—')}</td>
          <td data-label="Oleh">${esc(r.created_by_name || '—')}</td>
          <td data-label="Jurnal">${journalBadge}</td>
        </tr>`;
    }).join('');
  }

  const info = document.getElementById('saInfo');
if (info) {
  const shown = rows.length;
  const total = adjustTotalCount || totalCount;
  info.textContent = adjustFilter.onlyUnjournaled
    ? `Menampilkan ${shown} (belum dijurnal) dari ${adjustRowsCache.length} termuat`
    : `Menampilkan ${Math.min(adjustRowsCache.length, total)} dari ${total}`;
}
}
// ============================================================
// TAB OPNAME MASSAL (Phase 2)
// ============================================================
async function initOpnameTab() {
  const btnNew = document.getElementById('opnameNewBtn');
  if (btnNew) btnNew.style.display = perms.opnameCreate ? '' : 'none';

  const detail = document.getElementById('opnameDetailCard');
  if (detail) detail.style.display = 'none';

  if (perms.opnameCreate) wireOpnameCreateForm();

  const refreshTop = document.getElementById('opnameRefreshBtn');
  if (refreshTop) refreshTop.addEventListener('click', async () => {
    await reloadOpnameHistory();
    if (currentOpnameId) await loadOpnameDetail();
  });
  const refreshHist = document.getElementById('opnameHistRefreshBtn');
  if (refreshHist) refreshHist.addEventListener('click', () => reloadOpnameHistory());
  const moreLines = document.getElementById('opnameLinesMoreBtn');
  if (moreLines) moreLines.style.display = 'none';

  wireOpnameHistory();
  await reloadOpnameHistory();
}

// ---------- Buat opname baru ----------
function wireOpnameCreateForm() {
  const btnNew = document.getElementById('opnameNewBtn');
  const card = document.getElementById('opnameNewFormCard');
  const form = document.getElementById('form-opname-new');
  const btnCancel = document.getElementById('opnameCancelCreateBtn');
  if (!btnNew || !card || !form) return;

  const dateEl = form.querySelector('[name=opname_date]');
  if (dateEl) { dateEl.value = todayISO(); dateEl.max = todayISO(); }

  btnNew.addEventListener('click', () => {
    card.style.display = card.style.display === 'none' ? 'block' : 'none';
    if (card.style.display === 'block') {
      form.opname_date.value = todayISO();
      form.notes.value = '';
      form.opname_date.focus();
    }
  });

  if (btnCancel) btnCancel.addEventListener('click', () => {
    card.style.display = 'none';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('opnameCreateBtn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Membuat...'; }
    try {
      const { data, error } = await supabase.rpc('create_opname', {
        p_opname_date: form.opname_date.value,
        p_notes: form.notes.value.trim() || null
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      toast(`✓ Opname ${row.opname_no} dibuat (${row.line_count} item)`);
      card.style.display = 'none';
      form.reset();
      await reloadOpnameHistory();
      await openOpnameDetail(row.opname_id);
    } catch (err) {
      toast('Gagal buat opname: ' + (err.message || err), true);
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Buat Opname'; }
    }
  });
}

// ---------- Detail opname ----------
async function openOpnameDetail(opnameId) {
  currentOpnameId = Number(opnameId);
  const detail = document.getElementById('opnameDetailCard');
  if (detail) detail.style.display = 'block';
  await loadOpnameDetail();
}

async function loadOpnameDetail() {
  if (!currentOpnameId) return;
  const tbody = document.getElementById('tbody-opname-lines');
  const headerEl = document.getElementById('opnameDetailHeader');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';

  try {
    const { data, error } = await supabase.rpc('get_opname', { p_opname_id: currentOpnameId });
    if (error) throw error;
    const header = Array.isArray(data) ? data[0] : data;
    if (!header) throw new Error('Opname tidak ditemukan');

    opnameLinesCache = Array.isArray(header.lines) ? header.lines : [];
    window.__currentOpnameHeader = header;   // ← TAMBAH: simpan utk cetak

    currentOpnameStatus = header.status || '';
    renderOpnameHeader(header);
    renderOpnameLines(header.status);
    renderOpnameActions(header);
    
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
    if (headerEl) headerEl.innerHTML = `<span style="color:#b91c1c;">${esc(err.message)}</span>`;
  }
}

function renderOpnameHeader(h) {
  const el = document.getElementById('opnameDetailHeader');
  if (!el) return;
  let journalBadge = '';
  if (h.status === 'executed') {
    if (h.journal_entry_id != null) {
      const tgl = h.journal_posted_at ? new Date(h.journal_posted_at).toLocaleDateString('id-ID') : '';
      journalBadge = `<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px;">Jurnal sudah${tgl ? ' · ' + esc(tgl) : ''}</span>`;
    } else {
      journalBadge = `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px;">Belum dijurnal</span>`;
    }
  }
  el.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;">
      <div><b>${esc(h.opname_no)}</b> ${statusBadge(h.status)} ${journalBadge}</div>
      <div>Tanggal: <b>${esc(h.opname_date)}</b></div>
      <div>Dibuat: ${esc(fmtDateTime(h.created_at))}</div>
      ${h.submitted_at ? `<div>Submit: ${esc(fmtDateTime(h.submitted_at))}</div>` : ''}
      ${h.executed_at ? `<div>Eksekusi: ${esc(fmtDateTime(h.executed_at))}</div>` : ''}
      ${h.cancel_reason ? `<div style="color:#b91c1c;">Batal: ${esc(h.cancel_reason)}</div>` : ''}
    </div>
    ${h.notes ? `<div style="margin-top:6px;color:#6b7280;font-size:13px;">Catatan: ${esc(h.notes)}</div>` : ''}
  `;
}

function renderOpnameMeta(h) {
  const el = document.getElementById('opnameMetaInfo');
  if (!el) return;
  el.innerHTML = `
    <span style="margin-right:12px;">Total item: <b>${opnameLinesCache.length}</b></span>
    <span style="margin-right:12px;">Di-adjust: <b style="color:#059669;">${Number(h.adjusted_count)||0}</b></span>
    <span style="margin-right:12px;">Dilewati: <b style="color:#6b7280;">${Number(h.skipped_count)||0}</b></span>
  `;
}

function renderOpnameActions(h) {
  const el = document.getElementById('opnameActionBar');
  if (!el) return;
  const s = h.status;
  const btns = [];

    if (s === 'draft') {
    btns.push(`<button type="button" class="btn btn-secondary" id="opnamePrintBtn">🖨️ Cetak Form</button>`);
    if (perms.opnameCreate) {
      btns.push(`<button type="button" class="btn btn-primary" id="opnameSaveDraftBtn">Simpan Draft</button>`);
      btns.push(`<button type="button" class="btn btn-primary" id="opnameSubmitBtn" style="background:#0891b2;">Submit</button>`);
      btns.push(`<button type="button" class="btn btn-danger" id="opnameCancelBtn">Cancel</button>`);
    }
  }
  if (s === 'submitted' && perms.opnameApprove) {
    btns.push(`<button type="button" class="btn btn-primary" id="opnameExecuteBtn" style="background:#059669;">Approve &amp; Eksekusi</button>`);
    btns.push(`<button type="button" class="btn btn-danger" id="opnameRejectBtn">Reject</button>`);
  }
  if (s === 'submitted' && perms.opnameCreate) {
    btns.push(`<button type="button" class="btn btn-danger" id="opnameCancelBtn">Cancel</button>`);
  }
  if (!btns.length) {
    el.innerHTML = `<span style="color:#6b7280;font-size:13px;">Tidak ada aksi tersedia.</span>`;
    return;
  }
  el.innerHTML = btns.join(' ');

  document.getElementById('opnameSaveDraftBtn')?.addEventListener('click', () => saveOpnameDraft());
  document.getElementById('opnameSubmitBtn')?.addEventListener('click', () => submitOpnameHandler());
  document.getElementById('opnameExecuteBtn')?.addEventListener('click', () => executeOpnameHandler());
  document.getElementById('opnameRejectBtn')?.addEventListener('click', () => rejectOpnameHandler());
  document.getElementById('opnameCancelBtn')?.addEventListener('click', () => cancelOpnameHandler());
  document.getElementById('opnamePrintBtn')?.addEventListener('click', () => printOpnameForm());
}
function renderOpnameLines(status) {
  const tbody = document.getElementById('tbody-opname-lines');
  if (!tbody) return;
  const editable = status === 'draft' && perms.opnameCreate;

  let rows = opnameLinesCache.slice();
  if (opnameFilter.search) {
    const q = opnameFilter.search.toLowerCase();
    rows = rows.filter(r =>
      String(r.sku || '').toLowerCase().includes(q) ||
      String(r.item_name || '').toLowerCase().includes(q)
    );
  }
  if (opnameFilter.onlyDelta) {
    rows = rows.filter(r => {
      if (r.qty_physical == null) return false;
      return (Number(r.qty_physical) - Number(r.qty_system)) !== 0;
    });
  }

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#9ca3af;">Tidak ada item cocok</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const sys = Number(r.qty_system);
    const phys = r.qty_physical == null ? null : Number(r.qty_physical);
    const delta = phys == null ? null : (phys - sys);
    const deltaStr = delta == null ? '' : ((delta > 0 ? '+' : '') + fmt(delta));
    const deltaColor = delta == null ? '#6b7280' : (delta === 0 ? '#6b7280' : (delta > 0 ? '#059669' : '#b91c1c'));
    const reasonOpts = ['','rusak','hilang','salah_input','lainnya'].map(v =>
      `<option value="${v}" ${v === (r.reason||'') ? 'selected' : ''}>${v ? reasonLabel(v) : '— pilih —'}</option>`
    ).join('');
    const dis = editable ? '' : 'disabled';
    return `
      <tr data-line-id="${r.line_id}">
        <td data-label="SKU">${esc(r.sku)}</td>
        <td data-label="Nama">${esc(r.item_name)}</td>
        <td data-label="Satuan">${esc(r.unit)}</td>
        <td data-label="Stok Sistem" class="num">${fmt(sys)}</td>
        <td data-label="Qty Fisik">
          <input type="number" step="0.0001" min="0" ${dis}
                 class="opname-phys" value="${phys == null ? '' : phys}"
                 style="width:100px;padding:6px;border:1px solid #d0d5dd;border-radius:6px;">
        </td>
        <td data-label="Selisih" class="num opname-delta" style="color:${deltaColor};font-weight:600;">${deltaStr}</td>
        <td data-label="Alasan">
          <select class="opname-reason" ${dis}
                  style="padding:6px;border:1px solid #d0d5dd;border-radius:6px;">${reasonOpts}</select>
        </td>
        <td data-label="Memo">
          <input type="text" ${dis} class="opname-memo" value="${esc(r.memo||'')}"
                 maxlength="500" style="width:100%;padding:6px;border:1px solid #d0d5dd;border-radius:6px;">
        </td>
      </tr>`;
  }).join('');

  if (editable) wireOpnameLineInputs();
}

function wireOpnameLineInputs() {
  document.querySelectorAll('#tbody-opname-lines tr[data-line-id]').forEach(tr => {
    const lineId = Number(tr.dataset.lineId);
    const physEl = tr.querySelector('.opname-phys');
    const deltaEl = tr.querySelector('.opname-delta');
    const line = opnameLinesCache.find(x => Number(x.line_id) === lineId);
    if (!line || !physEl) return;

    physEl.addEventListener('input', () => {
      const sys = Number(line.qty_system);
      const v = physEl.value === '' ? null : Number(physEl.value);
      line.qty_physical = v;
      if (v == null) { deltaEl.textContent = ''; deltaEl.style.color = '#6b7280'; return; }
      const d = v - sys;
      deltaEl.textContent = (d > 0 ? '+' : '') + fmt(d);
      deltaEl.style.color = d === 0 ? '#6b7280' : (d > 0 ? '#059669' : '#b91c1c');
    });
    tr.querySelector('.opname-reason')?.addEventListener('change', (e) => { line.reason = e.target.value; });
    tr.querySelector('.opname-memo')?.addEventListener('input', (e) => { line.memo = e.target.value; });
  });
}

function collectOpnameLinePayload() {
  return opnameLinesCache
    .filter(l => l.qty_physical != null && l.qty_physical !== '')
    .map(l => ({
      line_id: l.line_id,
      qty_physical: Number(l.qty_physical),
      reason: l.reason || null,
      memo: l.memo || null
    }));
}

async function saveOpnameDraft() {
  if (!perms.opnameCreate) { toast('Tidak ada akses', true); return; }
  const btn = document.getElementById('opnameSaveDraftBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }
  try {
    const { data, error } = await supabase.rpc('save_opname_lines', {
      p_opname_id: currentOpnameId,
      p_lines: collectOpnameLinePayload()
    });
    if (error) throw error;
    const saved = Array.isArray(data) ? (data[0]?.saved_count ?? 0) : (data?.saved_count ?? 0);
    toast(`✓ Draft tersimpan (${saved} line)`);
    await loadOpnameDetail();
  } catch (err) {
    toast('Gagal simpan: ' + (err.message || err), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Simpan Draft'; }
  }
}
// ---------- Cetak form fisik opname (portrait, padat) ----------
function printOpnameForm() {
  if (!currentOpnameId) return;
  const h = window.__currentOpnameHeader || {};
  const tanggal = h.opname_date || '';
  const catatan = h.notes || '';

  // Pendekkan nama produk: maks 40 karakter, sisanya "..."
  const shortName = (s, max = 40) => {
    const str = String(s || '');
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  };

  const rowsHtml = opnameLinesCache.map((r, idx) => {
    const sys = Number(r.qty_system);
    const phys = r.qty_physical == null ? '' : Number(r.qty_physical);
    const delta = (r.qty_physical == null) ? '' : (Number(r.qty_physical) - sys);
    const fullName = r.item_name || '';
    return `
      <tr>
        <td class="c">${idx + 1}</td>
        <td class="sku">${esc(r.sku)}</td>
        <td title="${esc(fullName)}">${esc(shortName(fullName))}</td>
        <td class="c">${esc(r.unit)}</td>
        <td class="r">${fmt(sys)}</td>
        <td class="phys">${phys === '' ? '' : fmt(phys)}</td>
        <td class="r">${delta === '' ? '' : ((delta > 0 ? '+' : '') + fmt(delta))}</td>
        <td class="c">${r.reason ? esc(reasonLabel(r.reason).charAt(0)) : ''}</td>
        <td class="memo">${esc(r.memo || '')}</td>
      </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="id"><head><meta charset="UTF-8">
<title>Form Opname ${esc(h.opname_no || '')}</title>
<style>
  @page { size: A4 portrait; margin: 10mm 8mm; }
  html, body { margin: 0; padding: 0; background: #f3f4f6; }
  * { box-sizing: border-box; }
  .sheet {
    width: 210mm;
    min-height: 297mm;
    margin: 12px auto;
    padding: 10mm 8mm;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,.15);
    font-family: Arial, Helvetica, sans-serif;
    font-size: 9px;
    color: #000;
  }
  .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px; }
  .head h1 { font-size: 13px; margin: 0 0 3px; letter-spacing: .3px; }
  .head .meta { font-size: 9px; line-height: 1.4; }
  .head .meta b { display: inline-block; min-width: 52px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #000; padding: 2px 3px; vertical-align: top; font-size: 8.5px; }
  th { background: #eee; font-weight: 700; font-size: 8.5px; }
  td.c { text-align: center; }
  td.r { text-align: right; }
  td.sku { font-family: "Courier New", monospace; font-size: 8px; word-break: break-all; }
  td.memo { font-size: 8px; }
  td.phys { background: #fff; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .legend { margin-top: 6px; font-size: 8.5px; }
  .sign { display: flex; justify-content: space-between; margin-top: 24px; page-break-inside: avoid; }
  .sign div { text-align: center; width: 40%; font-size: 9px; }
  .sign .line { margin-top: 40px; border-top: 1px solid #000; padding-top: 3px; }
  .actions { position: fixed; top: 8px; right: 8px; z-index: 10; }
  .actions button { padding: 6px 12px; font-size: 13px; cursor: pointer; }
  @media print {
    html, body { background: #fff; }
    .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    .actions { display: none; }
  }
</style></head>
<body>
  <div class="actions">
    <button onclick="window.print()">🖨️ Cetak</button>
  </div>
  <div class="sheet">
  <div class="head">
    <div>
      <h1>FORM OPNAME MASSAL</h1>
      <div class="meta">
        <div><b>No.</b> ${esc(h.opname_no || '')}</div>
        <div><b>Tanggal</b> ${esc(tanggal)}</div>
        ${catatan ? `<div><b>Catatan</b> ${esc(catatan)}</div>` : ''}
      </div>
    </div>
    <div class="meta" style="text-align:right;">
      <div>Total item: <b>${opnameLinesCache.length}</b></div>
      <div>Dicetak: ${new Date().toLocaleString('id-ID')}</div>
    </div>
  </div>
  <table>
    <colgroup>
      <col style="width:24px;">
      <col style="width:70px;">
      <col>
      <col style="width:36px;">
      <col style="width:52px;">
      <col style="width:60px;">
      <col style="width:52px;">
      <col style="width:38px;">
      <col style="width:80px;">
    </colgroup>
    <thead>
      <tr>
        <th>No</th>
        <th>SKU</th>
        <th>Nama</th>
        <th>Sat.</th>
        <th>Stok<br>Sistem</th>
        <th>Qty<br>Fisik</th>
        <th>Selisih</th>
        <th>Alasan</th>
        <th>Memo</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="legend">
    Kode alasan: <b>R</b> = Rusak, <b>H</b> = Hilang, <b>S</b> = Salah input, <b>L</b> = Lainnya.
  </div>
    <div class="sign">
    <div>
      <div>Petugas Opname</div>
      <div class="line">(____________________)</div>
    </div>
    <div>
      <div>Penyelia / Supervisor</div>
      <div class="line">(____________________)</div>
    </div>
  </div>
  </div><!-- /.sheet -->
  <script>
    window.addEventListener('load', () => {
      // auto-print hanya kalau mau (uncomment):
      // setTimeout(() => window.print(), 300);
    });
  </script>
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) { toast('Popup diblokir browser. Izinkan popup untuk mencetak.', true); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
async function submitOpnameHandler() {
  if (!perms.opnameCreate) { toast('Tidak ada akses', true); return; }
  if (!confirm('Submit opname ini? Setelah submit, qty fisik tidak bisa diedit.')) return;
  const btn = document.getElementById('opnameSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Submit...'; }
  try {
    // simpan dulu, lalu submit
    const { error: eSave } = await supabase.rpc('save_opname_lines', {
      p_opname_id: currentOpnameId,
      p_lines: collectOpnameLinePayload()
    });
    if (eSave) throw eSave;
    const { error } = await supabase.rpc('submit_opname', { p_opname_id: currentOpnameId });
    if (error) throw error;
    toast('✓ Opname submitted');
    await loadOpnameDetail();
    await reloadOpnameHistory();
  } catch (err) {
    toast('Gagal submit: ' + (err.message || err), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
  }
}

async function executeOpnameHandler() {
  if (!perms.opnameApprove) { toast('Tidak ada akses eksekusi', true); return; }
  const rowsWithDelta = opnameLinesCache.filter(l => {
    if (l.qty_physical == null) return false;
    return Number(l.qty_physical) !== Number(l.qty_system);
  });
  const msg = `Approve & eksekusi opname ini?\n\n${rowsWithDelta.length} item akan di-adjust.`;
  if (!confirm(msg)) return;
  const btn = document.getElementById('opnameExecuteBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Mengeksekusi...'; }
  try {
    const { data, error } = await supabase.rpc('execute_opname', { p_opname_id: currentOpnameId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    toast(`✓ Eksekusi selesai: ${row.adjusted_count} adjust, ${row.skipped_count} dilewati`);
    await loadOpnameDetail();
    await reloadOpnameHistory();
    if (opnameInitialized) await renderInventory();
  } catch (err) {
    toast('Gagal eksekusi: ' + (err.message || err), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Approve & Eksekusi'; }
  }
}

async function rejectOpnameHandler() {
  if (!perms.opnameApprove) { toast('Tidak ada akses', true); return; }
  const reason = prompt('Alasan reject (opsional):', '');
  if (reason === null) return;
  const btn = document.getElementById('opnameRejectBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Reject...'; }
  try {
    const { error } = await supabase.rpc('reject_opname', {
      p_opname_id: currentOpnameId,
      p_reason: reason || null
    });
    if (error) throw error;
    toast('✓ Opname ditolak, kembali ke draft');
    await loadOpnameDetail();
    await reloadOpnameHistory();
  } catch (err) {
    toast('Gagal reject: ' + (err.message || err), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Reject'; }
  }
}

async function cancelOpnameHandler() {
  if (!perms.opnameCreate) { toast('Tidak ada akses', true); return; }
  const reason = prompt('Alasan cancel (opsional):', '');
  if (reason === null) return;
  if (!confirm('Batalkan opname ini? Tidak bisa dikembalikan.')) return;
  const btn = document.getElementById('opnameCancelBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Membatalkan...'; }
  try {
    const { error } = await supabase.rpc('cancel_opname', {
      p_opname_id: currentOpnameId,
      p_reason: reason || null
    });
    if (error) throw error;
    toast('✓ Opname dibatalkan');
    await loadOpnameDetail();
    await reloadOpnameHistory();
  } catch (err) {
    toast('Gagal cancel: ' + (err.message || err), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Cancel'; }
  }
}

// ---------- Filter input tabel besar (client-side) ----------
function wireOpnameLinesFilter() {
  const searchEl = document.getElementById('opnameLineSearch');
  const chkDelta = document.getElementById('opnameOnlyDiff');

  if (searchEl) {
    let t = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        opnameFilter.search = searchEl.value.trim();
        if (currentOpnameId) renderOpnameLines(currentOpnameStatus);
      }, 250);
    });
  }
  if (chkDelta) {
    chkDelta.addEventListener('change', () => {
      opnameFilter.onlyDelta = chkDelta.checked;
      if (currentOpnameId) renderOpnameLines(currentOpnameStatus);
    });
  }
}

// ---------- Riwayat opname ----------
function wireOpnameHistory() {
  const searchEl = document.getElementById('opnameHistSearch');
  const statusEl = document.getElementById('opnameHistStatus');
  const fromEl = document.getElementById('opnameHistFrom');
  const toEl = document.getElementById('opnameHistTo');
  const moreBtn = document.getElementById('opnameHistMoreBtn');

  if (searchEl) {
    let t = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        opnameHistFilter.search = searchEl.value.trim();
        await reloadOpnameHistory();
      }, 300);
    });
  }
  if (statusEl) statusEl.addEventListener('change', async () => {
    opnameHistFilter.status = statusEl.value;
    await reloadOpnameHistory();
  });
  if (fromEl) fromEl.addEventListener('change', async () => {
    opnameHistFilter.from = fromEl.value;
    await reloadOpnameHistory();
  });
  if (toEl) toEl.addEventListener('change', async () => {
    opnameHistFilter.to = toEl.value;
    await reloadOpnameHistory();
  });
  if (moreBtn) moreBtn.addEventListener('click', () => loadOpnameHistory(true));

  wireOpnameLinesFilter();
}

async function reloadOpnameHistory() {
  opnameHistOffset = 0;
  const tbody = document.getElementById('tbody-opname-history');
  if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  const moreBtn = document.getElementById('opnameHistMoreBtn');
  if (moreBtn) moreBtn.style.display = 'none';
  const info = document.getElementById('opnameHistInfo');
  if (info) info.textContent = '';
  await loadOpnameHistory(false);
}

async function loadOpnameHistory(append = false) {
  const tbody = document.getElementById('tbody-opname-history');
  if (!tbody) return;
  if (!append) tbody.innerHTML = '';
  const seq = ++opnameHistReqSeq;
  try {
    const { data, error } = await supabase.rpc('list_stock_opnames', {
      p_search: opnameHistFilter.search || null,
      p_status: opnameHistFilter.status || null,
      p_from:   opnameHistFilter.from   || null,
      p_to:     opnameHistFilter.to     || null,
      p_limit:  OPNAME_HIST_LIMIT,
      p_offset: opnameHistOffset
    });
    if (error) throw error;
    if (seq !== opnameHistReqSeq) return;

    const rows = data || [];
    const totalCount = rows[0]?.total_count != null ? Number(rows[0].total_count) : rows.length;

    if (!append && !rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#9ca3af;">Belum ada opname</td></tr>';
      return;
    }

    const html = rows.map(r => `
      <tr>
        <td data-label="No"><b>${esc(r.opname_no)}</b></td>
        <td data-label="Tanggal">${esc(r.opname_date)}</td>
        <td data-label="Status">${statusBadge(r.status)}</td>
        <td data-label="Line" class="num">${fmt(r.line_count)}</td>
        <td data-label="Adjust" class="num" style="color:#059669;font-weight:600;">${Number(r.adjusted_count)||0}</td>
        <td data-label="Skip" class="num" style="color:#6b7280;">${Number(r.skipped_count)||0}</td>
        <td data-label="Dibuat">${esc(fmtDateTime(r.created_at))}</td>
        <td data-label="Eksekusi">${r.executed_at ? esc(fmtDateTime(r.executed_at)) : '—'}</td>
        <td data-label="Aksi">
          <button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;"
                  data-open-opname="${r.id}">Lihat</button>
        </td>
      </tr>`).join('');

    if (append) tbody.insertAdjacentHTML('beforeend', html);
    else tbody.innerHTML = html;

    // bind tombol lihat
    tbody.querySelectorAll('[data-open-opname]').forEach(btn => {
      btn.addEventListener('click', () => openOpnameDetail(Number(btn.dataset.openOpname)));
    });

    opnameHistOffset += rows.length;
    const info = document.getElementById('opnameHistInfo');
    if (info) info.textContent = `Menampilkan ${Math.min(opnameHistOffset, totalCount)} dari ${totalCount}`;
    const moreBtn = document.getElementById('opnameHistMoreBtn');
    if (moreBtn) moreBtn.style.display = opnameHistOffset < totalCount ? 'inline-block' : 'none';
  } catch (err) {
    tbody.innerHTML += `<tr><td colspan="9" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

// ============================================================
// TAB PRICE LIST (Phase 3)
// ============================================================

// ---------- Init tab ----------
async function initPriceListTab() {
  // Sembunyikan toolbar edit kalau tidak punya manage
  if (!perms.priceListManage) {
    const reasonEl = document.getElementById('plReason');
    if (reasonEl) reasonEl.style.display = 'none';
    const saveBtn = document.getElementById('plSaveBtn');
    if (saveBtn) saveBtn.style.display = 'none';
  }

  wirePriceListToolbar();
  wirePriceListHistory();
  await Promise.all([reloadPriceList(), reloadPriceListHistory()]);
}

// ---------- Toolbar Card 1 ----------
function wirePriceListToolbar() {
  const searchEl = document.getElementById('plSearch');
  const chkOnly = document.getElementById('plOnlyWithPrice');
  const refreshBtn = document.getElementById('plRefreshBtn');
  const printBtn = document.getElementById('plPrintBtn');
  const moreBtn = document.getElementById('plMoreBtn');
  const saveBtn = document.getElementById('plSaveBtn');
  const reasonEl = document.getElementById('plReason');

  if (searchEl) {
    let t = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        priceListFilter.search = searchEl.value.trim();
        await reloadPriceList();
      }, 300);
    });
  }
  if (chkOnly) {
    chkOnly.addEventListener('change', async () => {
      priceListFilter.onlyWithPrice = chkOnly.checked;
      await reloadPriceList();
    });
  }
  if (refreshBtn) refreshBtn.addEventListener('click', () => reloadPriceList());
  if (printBtn)   printBtn.addEventListener('click', () => printPriceListForm());
  if (moreBtn)    moreBtn.addEventListener('click', () => loadPriceList(true));
  if (reasonEl)   reasonEl.addEventListener('input', updatePriceListSaveBtn);
  if (saveBtn)    saveBtn.addEventListener('click', () => savePriceListHandler('bulk'));
}

// ---------- Reload (reset offset) ----------
async function reloadPriceList() {
  priceListOffset = 0;
  priceListDirty = new Set();
  priceListRowsCache = [];
  const tbody = document.getElementById('tbody-price-list');
  if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  const moreBtn = document.getElementById('plMoreBtn');
  if (moreBtn) moreBtn.style.display = 'none';
  const info = document.getElementById('plInfo');
  if (info) info.textContent = '';
  updatePriceListSaveBtn();
  await loadPriceList(false);
}

// ---------- Load (append atau replace) ----------
async function loadPriceList(append = false) {
  const tbody = document.getElementById('tbody-price-list');
  if (!tbody) return;
  if (!append) tbody.innerHTML = '';
  const seq = ++priceListReqSeq;

  try {
    const { data, error } = await supabase.rpc('list_price_list', {
      p_search: priceListFilter.search || null,
      p_only_with_price: priceListFilter.onlyWithPrice,
      p_limit: PRICE_LIST_LIMIT,
      p_offset: priceListOffset
    });
    if (error) throw error;
    if (seq !== priceListReqSeq) return;

    const rows = data || [];
    const totalCount = rows[0]?.total_count != null ? Number(rows[0].total_count) : rows.length;

    if (append) priceListRowsCache = priceListRowsCache.concat(rows);
    else priceListRowsCache = rows;

    priceListTotalCount = totalCount;
    priceListOffset += rows.length;

    renderPriceListRows();
  } catch (err) {
    tbody.innerHTML += `<tr><td colspan="9" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

// ---------- Render tabel ----------
// ---------- Render tabel ----------
function renderPriceListRows() {
  const tbody = document.getElementById('tbody-price-list');
  if (!tbody) return;

  if (!priceListRowsCache.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#9ca3af;">Tidak ada item cocok</td></tr>';
    updatePriceListSaveBtn();
    return;
  }

  const canManage = perms.priceListManage;

  tbody.innerHTML = priceListRowsCache.map(r => {
    const itemId = Number(r.item_id);
    const hasPrice = r.has_price === true;
    const priceVal = hasPrice ? Number(r.price) : '';
    const discVal  = hasPrice ? Number(r.discount_pct) : 0;
    const effVal   = hasPrice ? Number(r.effective_price) : 0;
    const dis = canManage ? '' : 'disabled';
    const isDirty = priceListDirty.has(itemId);

    return `
      <tr data-item-id="${itemId}" class="${isDirty ? 'pl-dirty' : ''}"
          style="${isDirty ? 'background:#fef3c7;' : ''}">
        <td data-label="SKU">${esc(r.sku)}</td>
        <td data-label="Nama">${esc(r.item_name)}</td>
        <td data-label="Satuan">${esc(r.unit)}</td>
        <td data-label="Harga" class="num">
          <input type="number" step="0.01" min="0" ${dis}
                 class="pl-price" value="${priceVal === '' ? '' : priceVal}"
                 placeholder="${hasPrice ? '' : '—'}"
                 style="width:180px;min-width:180px;padding:10px 12px;font-size:15px;border:1px solid #d0d5dd;border-radius:6px;text-align:right;box-sizing:border-box;">
        </td>
        <td data-label="Diskon %" class="num">
          <input type="number" step="0.01" min="0" max="100" ${dis}
                 class="pl-disc" value="${discVal}"
                 style="width:80px;min-width:80px;padding:10px 8px;font-size:15px;border:1px solid #d0d5dd;border-radius:6px;text-align:right;box-sizing:border-box;">
        </td>
        <td data-label="Harga Efektif" class="num pl-eff" style="font-weight:600;white-space:nowrap;${hasPrice ? '' : 'color:#9ca3af;'}">
          ${hasPrice ? fmt(effVal) : '—'}
        </td>
        <td data-label="Diperbarui" style="white-space:nowrap;">
          ${hasPrice ? esc(fmtDateTime(r.updated_at)) : '—'}
        </td>
        <td data-label="Riwayat">
          <button type="button" class="btn btn-secondary pl-hist-btn"
                  data-item-id="${itemId}" style="padding:4px 10px;font-size:12px;">Riwayat</button>
        </td>
        <td data-label="Aksi">
          ${canManage ? `
            <button type="button" class="btn btn-primary pl-save-one"
                    data-item-id="${itemId}" disabled
                    style="padding:4px 10px;font-size:12px;margin-right:4px;">Simpan</button>
            ${hasPrice ? `
              <button type="button" class="btn btn-danger pl-delete"
                      data-item-id="${itemId}" data-sku="${esc(r.sku)}"
                      style="padding:4px 10px;font-size:12px;">Hapus</button>
            ` : ''}
          ` : '<span style="color:#9ca3af;">—</span>'}
        </td>
      </tr>`;
  }).join('');

  wirePriceListInputs();

  // Info & tombol "Muat lebih banyak"
  const info = document.getElementById('plInfo');
  if (info) info.textContent = `Menampilkan ${Math.min(priceListOffset, priceListTotalCount)} dari ${priceListTotalCount}`;
  const moreBtn = document.getElementById('plMoreBtn');
  if (moreBtn) moreBtn.style.display = priceListOffset < priceListTotalCount ? 'inline-block' : 'none';

  updatePriceListSaveBtn();
}

// ---------- Update tombol Simpan (bulk) ----------
function updatePriceListSaveBtn() {
  const saveBtn = document.getElementById('plSaveBtn');
  if (!saveBtn) return;
  saveBtn.disabled = priceListDirty.size === 0;
  saveBtn.textContent = priceListDirty.size > 0
    ? `Simpan Perubahan (${priceListDirty.size})`
    : 'Simpan Perubahan';
}

// ---------- Wire input harga/diskon + tombol per baris ----------
function wirePriceListInputs() {
  const tbody = document.getElementById('tbody-price-list');
  if (!tbody) return;

  tbody.querySelectorAll('tr[data-item-id]').forEach(tr => {
    const itemId = Number(tr.dataset.itemId);
    const priceEl = tr.querySelector('.pl-price');
    const discEl  = tr.querySelector('.pl-disc');
    const effEl   = tr.querySelector('.pl-eff');
    const saveOneBtn = tr.querySelector('.pl-save-one');
    const histBtn = tr.querySelector('.pl-hist-btn');
    const delBtn  = tr.querySelector('.pl-delete');

    const row = priceListRowsCache.find(x => Number(x.item_id) === itemId);
    if (!row) return;

    // Snapshot nilai awal (dari cache) untuk deteksi dirty
    const origPrice = row.has_price ? Number(row.price) : null;
    const origDisc  = row.has_price ? Number(row.discount_pct) : 0;

    const recompute = () => {
      const priceRaw = priceEl?.value ?? '';
      const discRaw  = discEl?.value ?? '';
      const price = priceRaw === '' ? null : Number(priceRaw);
      const disc  = discRaw === '' ? 0 : Number(discRaw);

      // Harga efektif (read-only)
      if (effEl) {
        if (price == null) {
          effEl.textContent = '—';
          effEl.style.color = '#9ca3af';
        } else {
          const eff = price * (1 - disc / 100);
          effEl.textContent = fmt(eff);
          effEl.style.color = '';
        }
      }

      // Deteksi dirty (bandingkan dengan snapshot awal)
      const changed = (price !== origPrice) || (disc !== origDisc);
      if (changed) {
        priceListDirty.add(itemId);
        tr.style.background = '#fef3c7';
      } else {
        priceListDirty.delete(itemId);
        tr.style.background = '';
      }

      // Update tombol simpan per baris
      if (saveOneBtn) saveOneBtn.disabled = !changed;

      updatePriceListSaveBtn();
    };

    priceEl?.addEventListener('input', recompute);
    discEl?.addEventListener('input', recompute);

    // Tombol Simpan per baris (U1 hybrid)
    saveOneBtn?.addEventListener('click', () => savePriceListHandler('single', itemId));

    // Tombol Riwayat per baris (U5)
    histBtn?.addEventListener('click', () => {
      priceListHistFilter.itemId = itemId;
      const skuTxt = row.sku || '';
      const nameTxt = row.item_name || '';
      const infoEl = document.getElementById('plHistFilterInfo');
      if (infoEl) {
        infoEl.style.display = 'block';
        infoEl.innerHTML = `Filter aktif: <b>${esc(skuTxt)} — ${esc(nameTxt)}</b>`;
      }
      const resetBtn = document.getElementById('plHistResetBtn');
      if (resetBtn) resetBtn.style.display = 'inline-block';
      reloadPriceListHistory();
    });

    // Tombol Hapus (U4 — hanya untuk manage)
    delBtn?.addEventListener('click', () => deletePriceListItemHandler(itemId, row.sku));
  });
}

// ---------- Kumpulkan payload perubahan ----------
function collectPriceListChanges(itemIdOnly = null) {
  const result = [];
  for (const itemId of priceListDirty) {
    if (itemIdOnly != null && itemId !== itemIdOnly) continue;

    const tr = document.querySelector(`#tbody-price-list tr[data-item-id="${itemId}"]`);
    if (!tr) continue;
    const priceEl = tr.querySelector('.pl-price');
    const discEl  = tr.querySelector('.pl-disc');
    if (!priceEl) continue;

    const priceRaw = priceEl.value;
    const discRaw  = discEl?.value ?? '0';
    const price = priceRaw === '' ? 0 : Number(priceRaw);
    const disc  = discRaw === '' ? 0 : Number(discRaw);

    // Validasi dasar
    if (isNaN(price) || price < 0) {
      toast(`Harga tidak valid untuk item ${itemId}`, true);
      return null;
    }
    if (isNaN(disc) || disc < 0 || disc > 100) {
      toast(`Diskon harus 0–100 untuk item ${itemId}`, true);
      return null;
    }

    result.push({ item_id: itemId, price, discount_pct: disc });
  }
  return result;
}

// ---------- Simpan (bulk / single) ----------
async function savePriceListHandler(mode = 'bulk', itemIdOnly = null) {
  if (!perms.priceListManage) { toast('Tidak ada akses ubah harga', true); return; }

  const lines = collectPriceListChanges(itemIdOnly);
  if (lines === null) return; // validasi gagal
  if (!lines.length) { toast('Tidak ada perubahan', true); return; }

  if (mode === 'bulk' && lines.length > 20) {
    if (!confirm(`Simpan ${lines.length} perubahan harga?`)) return;
  }

  const reason = document.getElementById('plReason')?.value.trim() || null;
  const bulkBtn = document.getElementById('plSaveBtn');
  const singleBtn = itemIdOnly != null
    ? document.querySelector(`#tbody-price-list tr[data-item-id="${itemIdOnly}"] .pl-save-one`)
    : null;

  const activeBtn = mode === 'single' ? singleBtn : bulkBtn;
  const origText = activeBtn?.textContent;
  if (activeBtn) { activeBtn.disabled = true; activeBtn.textContent = 'Menyimpan...'; }

  try {
    const { data, error } = await supabase.rpc('save_price_list', {
      p_lines: lines,
      p_reason: reason
    });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    const savedCount = Number(row?.saved_count ?? lines.length);
    const changedCount = Number(row?.changed_count ?? 0);

    toast(`✓ Tersimpan: ${savedCount} baris (${changedCount} berubah)`);

    // Clear reason input
    const reasonEl = document.getElementById('plReason');
    if (reasonEl) reasonEl.value = '';

    // Hapus dirty untuk item yang baru disimpan
    if (mode === 'single' && itemIdOnly != null) {
      priceListDirty.delete(itemIdOnly);
      updatePriceListSaveBtn();
    } else {
      priceListDirty.clear();
      updatePriceListSaveBtn();
    }

    // Reload tabel + riwayat
    await Promise.all([reloadPriceList(), reloadPriceListHistory()]);
  } catch (err) {
    toast('Gagal simpan: ' + (err.message || err), true);
  } finally {
    if (activeBtn) {
      activeBtn.disabled = false;
      activeBtn.textContent = origText || (mode === 'single' ? 'Simpan' : 'Simpan Perubahan');
    }
    updatePriceListSaveBtn();
  }
}

// ---------- Hapus price list item ----------
async function deletePriceListItemHandler(itemId, sku) {
  if (!perms.priceListManage) { toast('Tidak ada akses hapus', true); return; }
  const ok = confirm(
    `Hapus harga untuk item ${sku || itemId}?\n\n` +
    `Setelah dihapus, item ini TIDAK BISA dijual sampai harga diisi kembali (D7).\n` +
    `Riwayat perubahan tetap tersimpan.`
  );
  if (!ok) return;

  try {
    const { data, error } = await supabase.rpc('delete_price_list_item', { p_item_id: itemId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.deleted) {
      toast('✓ Harga item dihapus');
    } else {
      toast('Item tidak ditemukan atau sudah tanpa harga', true);
    }
    priceListDirty.delete(itemId);
    await Promise.all([reloadPriceList(), reloadPriceListHistory()]);
  } catch (err) {
    toast('Gagal hapus: ' + (err.message || err), true);
  }
}

// ---------- Wire toolbar Card 2 (riwayat) ----------
function wirePriceListHistory() {
  const searchEl = document.getElementById('plHistSearch');
  const resetBtn = document.getElementById('plHistResetBtn');
  const moreBtn  = document.getElementById('plHistMoreBtn');

  if (searchEl) {
    let t = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        priceListHistFilter.search = searchEl.value.trim();
        await reloadPriceListHistory();
      }, 300);
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      priceListHistFilter.itemId = null;
      priceListHistFilter.search = '';
      const searchField = document.getElementById('plHistSearch');
      if (searchField) searchField.value = '';
      const infoEl = document.getElementById('plHistFilterInfo');
      if (infoEl) { infoEl.style.display = 'none'; infoEl.innerHTML = ''; }
      resetBtn.style.display = 'none';
      await reloadPriceListHistory();
    });
  }

  if (moreBtn) moreBtn.addEventListener('click', () => loadPriceListHistory(true));
}

// ---------- Reload riwayat (reset offset) ----------
async function reloadPriceListHistory() {
  priceListHistOffset = 0;
  const tbody = document.getElementById('tbody-price-list-history');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  const moreBtn = document.getElementById('plHistMoreBtn');
  if (moreBtn) moreBtn.style.display = 'none';
  const info = document.getElementById('plHistInfo');
  if (info) info.textContent = '';
  await loadPriceListHistory(false);
}

// ---------- Load riwayat ----------
async function loadPriceListHistory(append = false) {
  const tbody = document.getElementById('tbody-price-list-history');
  if (!tbody) return;
  if (!append) tbody.innerHTML = '';
  const seq = ++priceListHistReqSeq;

  try {
    const { data, error } = await supabase.rpc('list_price_list_history', {
      p_item_id: priceListHistFilter.itemId ?? null,
      p_limit:   PRICE_LIST_HIST_LIMIT,
      p_offset:  priceListHistOffset
    });
    if (error) throw error;
    if (seq !== priceListHistReqSeq) return;

    const rows = data || [];
    const totalCount = rows[0]?.total_count != null ? Number(rows[0].total_count) : rows.length;

    if (!append && !rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Belum ada riwayat perubahan</td></tr>';
      if (priceListHistFilter.itemId != null) {
        // filter per item tapi kosong — beri hint
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Belum ada riwayat untuk item ini</td></tr>';
      }
      return;
    }

    // Filter client-side by search (RPC tidak punya p_search di handoff)
    let filtered = rows;
    if (priceListHistFilter.search) {
      const q = priceListHistFilter.search.toLowerCase();
      filtered = rows.filter(r =>
        String(r.sku || '').toLowerCase().includes(q) ||
        String(r.item_name || '').toLowerCase().includes(q)
      );
    }

    const html = filtered.map(r => {
      const oldPrice = r.old_price == null ? '—' : fmt(r.old_price);
      const newPrice = r.new_price == null ? '—' : fmt(r.new_price);
      const oldDisc  = r.old_discount == null ? '—' : fmt(r.old_discount);
      const newDisc  = r.new_discount == null ? '—' : fmt(r.new_discount);
      return `
        <tr>
          <td data-label="Waktu" style="white-space:nowrap;">${esc(fmtDateTime(r.changed_at))}</td>
          <td data-label="SKU">${esc(r.sku)}</td>
          <td data-label="Nama">${esc(r.item_name)}</td>
          <td data-label="Harga" class="num">${oldPrice} → <b>${newPrice}</b></td>
          <td data-label="Diskon" class="num">${oldDisc}% → <b>${newDisc}%</b></td>
          <td data-label="Oleh">${esc(r.changed_by_name || '—')}</td>
          <td data-label="Alasan">${esc(r.reason || '—')}</td>
        </tr>`;
    }).join('');

    if (append) tbody.insertAdjacentHTML('beforeend', html);
    else tbody.innerHTML = html || '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Tidak ada hasil cocok</td></tr>';

    priceListHistOffset += rows.length;
    const info = document.getElementById('plHistInfo');
    if (info) info.textContent = `Menampilkan ${Math.min(priceListHistOffset, totalCount)} dari ${totalCount}`;
    const moreBtn = document.getElementById('plHistMoreBtn');
    if (moreBtn) moreBtn.style.display = priceListHistOffset < totalCount ? 'inline-block' : 'none';
  } catch (err) {
    tbody.innerHTML += `<tr><td colspan="7" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

// ---------- Cetak form price list (portrait, padat) ----------
function printPriceListForm() {
  if (!priceListRowsCache.length) {
    toast('Tidak ada data untuk dicetak', true);
    return;
  }

  const shortName = (s, max = 40) => {
    const str = String(s || '');
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  };

  const filterInfo = [];
  if (priceListFilter.search) filterInfo.push(`Cari: "${priceListFilter.search}"`);
  if (priceListFilter.onlyWithPrice) filterInfo.push('Hanya yang sudah ada harga');

  const rowsHtml = priceListRowsCache.map((r, idx) => {
    const hasPrice = r.has_price === true;
    const price = hasPrice ? fmt(r.price) : '';
    const disc  = hasPrice ? fmt(r.discount_pct) : '';
    const eff   = hasPrice ? fmt(r.effective_price) : '';
    const fullName = r.item_name || '';
    return `
      <tr>
        <td class="c">${idx + 1}</td>
        <td class="sku">${esc(r.sku)}</td>
        <td title="${esc(fullName)}">${esc(shortName(fullName))}</td>
        <td class="c">${esc(r.unit)}</td>
        <td class="r">${price}</td>
        <td class="r">${disc}</td>
        <td class="r">${eff}</td>
        <td class="new"></td>
        <td class="memo"></td>
      </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="id"><head><meta charset="UTF-8">
<title>Daftar Harga</title>
<style>
  @page { size: A4 portrait; margin: 10mm 8mm; }
  html, body { margin: 0; padding: 0; background: #f3f4f6; }
  * { box-sizing: border-box; }
  .sheet {
    width: 210mm;
    min-height: 297mm;
    margin: 12px auto;
    padding: 10mm 8mm;
    background: #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,.15);
    font-family: Arial, Helvetica, sans-serif;
    font-size: 9px;
    color: #000;
  }
  .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px; }
  .head h1 { font-size: 13px; margin: 0 0 3px; letter-spacing: .3px; }
  .head .meta { font-size: 9px; line-height: 1.4; }
  .head .meta b { display: inline-block; min-width: 52px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #000; padding: 2px 3px; vertical-align: top; font-size: 8.5px; }
  th { background: #eee; font-weight: 700; font-size: 8.5px; }
  td.c { text-align: center; }
  td.r { text-align: right; }
  td.sku { font-family: "Courier New", monospace; font-size: 8px; word-break: break-all; }
  td.memo { font-size: 8px; }
  td.new { background: #fff; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .legend { margin-top: 6px; font-size: 8.5px; }
  .sign { display: flex; justify-content: space-between; margin-top: 24px; page-break-inside: avoid; }
  .sign div { text-align: center; width: 40%; font-size: 9px; }
  .sign .line { margin-top: 40px; border-top: 1px solid #000; padding-top: 3px; }
  .actions { position: fixed; top: 8px; right: 8px; z-index: 10; }
  .actions button { padding: 6px 12px; font-size: 13px; cursor: pointer; }
  @media print {
    html, body { background: #fff; }
    .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    .actions { display: none; }
  }
</style></head>
<body>
  <div class="actions">
    <button onclick="window.print()">🖨️ Cetak</button>
  </div>
  <div class="sheet">
  <div class="head">
    <div>
      <h1>DAFTAR HARGA</h1>
      <div class="meta">
        <div><b>Tanggal</b> ${esc(new Date().toLocaleDateString('id-ID'))}</div>
        ${filterInfo.length ? `<div><b>Filter</b> ${esc(filterInfo.join(' · '))}</div>` : ''}
      </div>
    </div>
    <div class="meta" style="text-align:right;">
      <div>Total item: <b>${priceListRowsCache.length}</b></div>
      <div>Dicetak: ${new Date().toLocaleString('id-ID')}</div>
    </div>
  </div>
  <table>
    <colgroup>
      <col style="width:24px;">
      <col style="width:70px;">
      <col>
      <col style="width:36px;">
      <col style="width:64px;">
      <col style="width:44px;">
      <col style="width:64px;">
      <col style="width:64px;">
      <col style="width:80px;">
    </colgroup>
    <thead>
      <tr>
        <th>No</th>
        <th>SKU</th>
        <th>Nama</th>
        <th>Sat.</th>
        <th>Harga<br>Sekarang</th>
        <th>Diskon<br>%</th>
        <th>Harga<br>Efektif</th>
        <th>Harga Baru</th>
        <th>Memo</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="legend">
    Harga belum termasuk PPN. Kolom <b>Harga Baru</b> &amp; <b>Memo</b> diisi manual saat rapat penyesuaian harga.
  </div>
  <div class="sign">
    <div>
      <div>Disiapkan oleh</div>
      <div class="line">(____________________)</div>
    </div>
    <div>
      <div>Disetujui oleh</div>
      <div class="line">(____________________)</div>
    </div>
  </div>
  </div><!-- /.sheet -->
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) { toast('Popup diblokir browser. Izinkan popup untuk mencetak.', true); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
// ============================================================
// UNITS (v6s.F2) — dropdown satuan + modal kelola
// ============================================================
async function loadUnitsAndFillDropdown() {
  try {
    allUnits = await listUnits();
    fillUnitDropdowns();
  } catch (err) {
    console.error('loadUnitsAndFillDropdown:', err);
    toast('Gagal memuat daftar satuan: ' + (err.message || err), true);
  }
}

function fillUnitDropdowns() {
  const sel = document.getElementById('newItemUnit');
  if (sel) {
    const current = sel.value;
    sel.innerHTML = '<option value="">— pilih satuan —</option>' +
      allUnits.map(u =>
        `<option value="${esc(u.name)}">${esc(u.name)}</option>`
      ).join('');
    if (current) sel.value = current;
  }
}

function wireUnitsModal() {
  const modal = document.getElementById('unitsModal');
  const openBtn = document.getElementById('manageUnitsBtn');
  const closeBtn = document.getElementById('closeUnitsModalBtn');
  const addBtn = document.getElementById('addUnitBtn');
  if (!modal || !openBtn) return;

  openBtn.addEventListener('click', async () => {
    modal.style.display = 'flex';
    await renderUnitsList();
  });
  closeBtn?.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });

  addBtn?.addEventListener('click', async () => {
    const codeEl = document.getElementById('newUnitCode');
    const nameEl = document.getElementById('newUnitName');
    const sortEl = document.getElementById('newUnitSort');
    const code = codeEl.value.trim();
    const name = nameEl.value.trim();
    if (!code || !name) { toast('Kode dan nama wajib diisi', true); return; }

    addBtn.disabled = true;
    addBtn.textContent = 'Menyimpan...';
    try {
      await createUnit({ code, name, sort_order: Number(sortEl.value) || 100 });
      toast('✓ Unit ditambahkan');
      codeEl.value = '';
      nameEl.value = '';
      sortEl.value = '100';
      await loadUnitsAndFillDropdown();
      await renderUnitsList();
    } catch (err) {
      toast('Gagal: ' + (err.message || err), true);
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = '+ Tambah';
    }
  });
}

async function renderUnitsList() {
  const wrap = document.getElementById('unitsList');
  if (!wrap) return;
  wrap.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:12px;">Memuat...</div>';
  try {
    const rows = await listUnits({ includeInactive: true });
    if (!rows.length) {
      wrap.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:12px;">Belum ada unit.</div>';
      return;
    }

    wrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid #e5e7eb;">
            <th style="padding:6px 4px;text-align:left;font-size:11px;color:#6b7280;">Kode</th>
            <th style="padding:6px 4px;text-align:left;font-size:11px;color:#6b7280;">Nama</th>
            <th style="padding:6px 4px;text-align:right;font-size:11px;color:#6b7280;">Urutan</th>
            <th style="padding:6px 4px;text-align:center;font-size:11px;color:#6b7280;">Status</th>
            <th style="padding:6px 4px;text-align:right;font-size:11px;color:#6b7280;">Aksi</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(u => `
            <tr data-unit-id="${u.id}" style="border-bottom:1px solid #f3f4f6;${u.is_active ? '' : 'opacity:.55;'}">
              <td style="padding:6px 4px;font-family:'Courier New',monospace;font-size:12px;">${esc(u.code)}</td>
              <td style="padding:6px 4px;">
                <input type="text" class="unit-name-input" value="${esc(u.name)}" maxlength="80"
                       style="width:100%;padding:4px 6px;border:1px solid #d0d5dd;border-radius:5px;font-size:13px;">
              </td>
              <td style="padding:6px 4px;text-align:right;">
                <input type="number" class="unit-sort-input" value="${u.sort_order || 0}"
                       style="width:70px;padding:4px 6px;border:1px solid #d0d5dd;border-radius:5px;font-size:13px;text-align:right;">
              </td>
              <td style="padding:6px 4px;text-align:center;font-size:12px;">
                ${u.is_active
                  ? '<span style="background:#d1fae5;color:#065f46;padding:2px 6px;border-radius:4px;font-weight:600;">Aktif</span>'
                  : '<span style="background:#e5e7eb;color:#6b7280;padding:2px 6px;border-radius:4px;font-weight:600;">Nonaktif</span>'}
              </td>
              <td style="padding:6px 4px;text-align:right;white-space:nowrap;">
                <button type="button" class="btn btn-primary unit-save-btn"
                        style="padding:4px 10px;font-size:12px;">Simpan</button>
                ${u.is_active
                  ? `<button type="button" class="btn btn-danger unit-delete-btn"
                            style="padding:4px 10px;font-size:12px;margin-left:4px;">Nonaktif</button>`
                  : `<button type="button" class="btn btn-secondary unit-reactivate-btn"
                            style="padding:4px 10px;font-size:12px;margin-left:4px;">Aktifkan</button>`}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    // Bind tombol per baris
    wrap.querySelectorAll('[data-unit-id]').forEach(tr => {
      const id = Number(tr.dataset.unitId);
      tr.querySelector('.unit-save-btn')?.addEventListener('click', async () => {
        const name = tr.querySelector('.unit-name-input').value.trim();
        const sort = Number(tr.querySelector('.unit-sort-input').value) || 0;
        try {
          await updateUnit(id, { name, sort_order: sort });
          toast('✓ Unit diupdate');
          await loadUnitsAndFillDropdown();
          await renderUnitsList();
        } catch (err) {
          toast('Gagal: ' + (err.message || err), true);
        }
      });
      tr.querySelector('.unit-delete-btn')?.addEventListener('click', async () => {
        if (!confirm('Nonaktifkan unit ini? Unit tidak muncul di dropdown, tapi data lama tetap valid.')) return;
        try {
          await deleteUnit(id);
          toast('✓ Unit dinonaktifkan');
          await loadUnitsAndFillDropdown();
          await renderUnitsList();
        } catch (err) {
          toast('Gagal: ' + (err.message || err), true);
        }
      });
      tr.querySelector('.unit-reactivate-btn')?.addEventListener('click', async () => {
        try {
          await reactivateUnit(id);
          toast('✓ Unit diaktifkan');
          await loadUnitsAndFillDropdown();
          await renderUnitsList();
        } catch (err) {
          toast('Gagal: ' + (err.message || err), true);
        }
      });
    });
  } catch (err) {
    wrap.innerHTML = `<div style="color:#b91c1c;text-align:center;padding:12px;">${esc(err.message)}</div>`;
  }
}