// js/inventory-page.js
import './input-clear.js';                                  // ← TAMBAH: tombol clear (×)
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

let allItems = [];
let inventoryRows = [];
const perms = {
  create: false, stockIn: false, viewPrice: false, viewMovement: false,
  stockAdjust: false
};
const invFilter = {
  search: '',
  onlyReserved: false,
  onlyLowStock: false
};
// ---------- state tab koreksi stok (Phase 1) ----------
let stockAdjustInitialized = false;
let allItemsForAdjust = [];
const adjustFilter = { search: '', from: '', to: '' };
const ADJUST_LIMIT = 50;
let adjustOffset = 0;
let adjustReqSeq = 0;

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

  if (!perms.create)  document.getElementById('form-new-item').style.display = 'none';
  if (!perms.stockIn) document.getElementById('form-stock-in').style.display = 'none';
  if (!perms.viewMovement) {
    const histCard = document.getElementById('tbody-movements')?.closest('.card');
    if (histCard) histCard.style.display = 'none';
  }

  document.querySelector('#form-stock-in [name=movement_date]').value =
    new Date().toISOString().slice(0, 10);

  if (perms.create)  document.getElementById('form-new-item').addEventListener('submit', onCreateItem);
  if (perms.stockIn) document.getElementById('form-stock-in').addEventListener('submit', onStockIn);

  bindInventoryFilters();
    // Tab switcher (Koreksi Stok lazy-init)
  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      document.getElementById('tab-' + btn.dataset.tab).style.display = 'block';

      if (btn.dataset.tab === 'adjust' && !stockAdjustInitialized) {
        stockAdjustInitialized = true;
        try { await initStockAdjustTab(); }
        catch (err) {
          document.getElementById('tbody-stock-adjust').innerHTML =
            `<tr><td colspan="10" style="color:#b91c1c;">Gagal memuat: ${esc(err.message)}</td></tr>`;
        }
      }
    });
  });
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
        await renderInventory();   // RPC ulang (server-side filter)
      }, 300);
    });
  }
  if (chkReserved) {
    chkReserved.addEventListener('change', async () => {
      invFilter.onlyReserved = chkReserved.checked;
      await renderInventory();     // RPC ulang (server-side filter)
    });
  }
  if (chkLow) {
    chkLow.addEventListener('change', () => {
      invFilter.onlyLowStock = chkLow.checked;
      renderInventoryTable();      // client-side saja
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
  if (invFilter.onlyLowStock) {
    rows = rows.filter(r => r.is_low_stock);
  }

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
    if (stock === 0) {
      statusHtml = '<span style="color:#b91c1c;font-weight:600;">KOSONG</span>';
    } else if (i.is_low_stock) {
      statusHtml = '<span style="color:#b45309;font-weight:600;">RENDAH</span>';
    } else {
      statusHtml = '<span style="color:#059669;">OK</span>';
    }

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

// ---------- movements ----------
async function renderMovements() {
  const tbody = document.getElementById('tbody-movements');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
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
      return `
        <tr>
          <td data-label="Tanggal">${esc(m.movement_date)}</td>
          <td data-label="Item">${esc(m.items?.sku || '')} — ${esc(m.items?.name || '')}</td>
          <td data-label="Tipe">${esc(m.type)}</td>
          <td data-label="Qty" class="num">${fmt(m.qty)}</td>
          ${priceCols}
          <td data-label="Memo">${esc(m.memo || '—')}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Belum ada movement</td></tr>';
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
  // Sembunyikan form kalau tidak berhak; riwayat tetap tampil.
  const formCard = document.getElementById('stock-adjust-form-card');
  if (!perms.stockAdjust && formCard) formCard.style.display = 'none';

  // Set tanggal default = hari ini, max = hari ini (validasi final di server)
  const dateEl = document.getElementById('saDate');
  if (dateEl) {
    const today = new Date().toISOString().slice(0, 10);
    dateEl.value = today;
    dateEl.max = today;
  }

  // Isi dropdown item (pakai listItems existing, bukan RPC baru)
  await loadItemsForAdjust();

  // Wiring form (hanya kalau berhak)
  if (perms.stockAdjust) {
    wireStockAdjustForm();
  }

  // Wiring riwayat + load awal
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
    // Disable kalau delta 0 atau field wajib kosong
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

      // Reset form
      form.reset();
      document.getElementById('saMemo').value = '';
      document.getElementById('saQtySystem').value = '';
      document.getElementById('saDelta').value = '';
      const today = new Date().toISOString().slice(0, 10);
      document.getElementById('saDate').value = today;
      btn.disabled = true;

      // Reload riwayat + daftar stok utama (biar angka di tab "Stok & Item" ikut update)
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
  if (fromEl) {
    fromEl.addEventListener('change', async () => {
      adjustFilter.from = fromEl.value;
      await reloadStockAdjust();
    });
  }
  if (toEl) {
    toEl.addEventListener('change', async () => {
      adjustFilter.to = toEl.value;
      await reloadStockAdjust();
    });
  }
  if (refreshBtn) refreshBtn.addEventListener('click', () => reloadStockAdjust());
  if (moreBtn) moreBtn.addEventListener('click', () => loadStockAdjust(true));
}

async function reloadStockAdjust() {
  adjustOffset = 0;
  const tbody = document.getElementById('tbody-stock-adjust');
  if (tbody) tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  const moreBtn = document.getElementById('saMoreBtn');
  if (moreBtn) moreBtn.style.display = 'none';
  const info = document.getElementById('saInfo');
  if (info) info.textContent = '';
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
    if (seq !== adjustReqSeq) return;   // abaikan respons basi

    const rows = data || [];
    const totalCount = rows[0]?.total_count != null ? Number(rows[0].total_count) : rows.length;

    if (!append && !rows.length) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#9ca3af;">Belum ada koreksi stok</td></tr>';
      const info = document.getElementById('saInfo');
      if (info) info.textContent = '';
      return;
    }

    const html = rows.map(r => {
      const d = Number(r.qty_delta);
      const dStr = (d > 0 ? '+' : '') + fmt(d);
      const dColor = d > 0 ? '#059669' : '#b91c1c';
      return `
        <tr>
          <td data-label="Tanggal" style="white-space:nowrap;">${esc(r.adjust_date)}</td>
          <td data-label="SKU">${esc(r.sku)}</td>
          <td data-label="Item">${esc(r.item_name)}</td>
          <td data-label="Satuan">${esc(r.unit)}</td>
          <td data-label="Sebelum" class="num">${fmt(r.qty_before)}</td>
          <td data-label="Sesudah" class="num">${fmt(r.qty_after)}</td>
          <td data-label="Delta" class="num" style="color:${dColor};font-weight:600;">${dStr}</td>
          <td data-label="Alasan">${esc(r.reason)}</td>
          <td data-label="Memo">${esc(r.memo || '—')}</td>
          <td data-label="Oleh">${esc(r.created_by_name || '—')}</td>
        </tr>`;
    }).join('');

    if (append) tbody.insertAdjacentHTML('beforeend', html);
    else tbody.innerHTML = html;

    adjustOffset += rows.length;
    const info = document.getElementById('saInfo');
    if (info) info.textContent = `Menampilkan ${Math.min(adjustOffset, totalCount)} dari ${totalCount}`;
    const moreBtn = document.getElementById('saMoreBtn');
    if (moreBtn) moreBtn.style.display = adjustOffset < totalCount ? 'inline-block' : 'none';
  } catch (err) {
    tbody.innerHTML += `<tr><td colspan="10" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}