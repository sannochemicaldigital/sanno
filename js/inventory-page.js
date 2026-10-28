// js/inventory-page.js
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { listItems } from './items.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

(async () => {
  const user = await requireAuth();
  if (!user) return;

  const role = await requirePageAccess('inventory');
  if (!role) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  await renderNav(document.getElementById('mainNav'), 'inventory');

  const tbody = document.getElementById('tbody-inventory');
  try {
    const items = await listItems();
    tbody.innerHTML = items.map(i => {
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
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
})();