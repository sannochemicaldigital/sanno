// js/inventory-page.js
import './input-clear.js';
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission } from './permissions.js';
import { listItems, createItem } from './items.js';
import { supabase } from './supabase-client.js';

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
const perms = {
  create: false, stockIn: false, viewPrice: false, viewMovement: false,
  stockAdjust: false,
  opnameView: false, opnameCreate: false, opnameApprove: false
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

  if (!perms.create)  document.getElementById('form-new-item').style.display = 'none';
  if (!perms.stockIn) document.getElementById('form-stock-in').style.display = 'none';
  if (!perms.viewMovement) {
    const histCard = document.getElementById('tbody-movements')?.closest('.card');
    if (histCard) histCard.style.display = 'none';
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
    });
  });

  bindInventoryFilters();
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
    await createItem({
      sku: f.sku.value.trim(),
      name: f.name.value.trim(),
      unit: f.unit.value.trim() || 'pcs',
      min_stock: Number(f.min_stock.value) || 0
    });
    toast('✓ Item baru dibuat (stok 0)');
    f.reset();
    f.unit.value = 'pcs';
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

  if (s === 'draft' && perms.opnameCreate) {
    btns.push(`<button type="button" class="btn btn-primary" id="opnameSaveDraftBtn">Simpan Draft</button>`);
    btns.push(`<button type="button" class="btn btn-primary" id="opnameSubmitBtn" style="background:#0891b2;">Submit</button>`);
    btns.push(`<button type="button" class="btn btn-danger" id="opnameCancelBtn">Cancel</button>`);
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