// js/inventory-page.js
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
const perms = {
  create: false, stockIn: false, viewPrice: false, viewMovement: false
};

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

  if (!perms.create)  document.getElementById('form-new-item').style.display = 'none';
  if (!perms.stockIn) document.getElementById('form-stock-in').style.display = 'none';
  if (!perms.viewMovement) {
    const histCard = document.getElementById('tbody-movements')?.closest('.card');
    if (histCard) histCard.style.display = 'none';
  }

  // Sembunyikan kolom harga di riwayat kalau tidak punya izin
  if (!perms.viewPrice) {
    document.querySelectorAll('#tbody-movements').forEach(() => {});
  }

  document.querySelector('#form-stock-in [name=movement_date]').value =
    new Date().toISOString().slice(0, 10);

  if (perms.create)  document.getElementById('form-new-item').addEventListener('submit', onCreateItem);
  if (perms.stockIn) document.getElementById('form-stock-in').addEventListener('submit', onStockIn);

  await loadAll();
})();

async function loadAll() {
  const tasks = [renderInventory()];
  if (perms.viewMovement) tasks.push(renderMovements());
  await Promise.all(tasks);
}

async function renderInventory() {
  const tbody = document.getElementById('tbody-inventory');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  try {
    allItems = await listItems();
    tbody.innerHTML = allItems.map(i => {
      const qty = Number(i.stock_qty);
      const min = Number(i.min_stock);
      let status = '<span style="color:#059669;">OK</span>';
      if (qty === 0) status = '<span style="color:#b91c1c;font-weight:600;">KOSONG</span>';
      else if (qty <= min) status = '<span style="color:#b45309;font-weight:600;">RENDAH</span>';
      return `
        <tr>
          <td data-label="SKU">${esc(i.sku)}</td>
          <td data-label="Nama">${esc(i.name)}</td>
          <td data-label="Satuan">${esc(i.unit)}</td>
          <td data-label="Stok" class="num">${qty.toLocaleString('id-ID')}</td>
          <td data-label="Min" class="num">${min.toLocaleString('id-ID')}</td>
          <td data-label="Status">${status}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="6" style="text-align:center;color:#9ca3af;">Belum ada item</td></tr>';

    if (perms.stockIn) {
      const sel = document.getElementById('stockInItem');
      if (sel) {
        sel.innerHTML = '<option value="">— pilih item —</option>' +
          allItems.map(i =>
            `<option value="${i.id}">${esc(i.sku)} — ${esc(i.name)} (stok: ${Number(i.stock_qty).toLocaleString('id-ID')})</option>`
          ).join('');
      }
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

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