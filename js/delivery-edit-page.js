import { requireAuth, logout } from './auth.js';
import { hasPermission } from './permissions.js';
import { supabase } from './supabase-client.js';

// ... util toast, esc, fmt ...

(async () => {
  const user = await requireAuth();
  if (!user) return;

  const canEdit = await hasPermission('delivery.edit_display_name');
  if (!canEdit) { alert('Tidak ada akses'); window.location.href = './delivery.html'; return; }

  const params = new URLSearchParams(window.location.search);
  const doId = Number(params.get('id'));
  if (!doId) { alert('Parameter ?id= wajib'); return; }

  // Fetch DO + lines
  const { data: doData, error: e1 } = await supabase
    .from('delivery_orders')
    .select(`*, sales_orders!inner(id, so_no, partners!inner(name))`)
    .eq('id', doId)
    .single();
  if (e1) { alert(e1.message); return; }

  if (doData.status !== 'issued') {
    alert(`Edit hanya bisa saat DO issued. Status: ${doData.status}`);
    window.location.href = './delivery.html';
    return;
  }

  const { data: lines, error: e2 } = await supabase
    .from('sales_order_lines')
    .select('id, item_id, qty, unit_price, subtotal, display_name, so_discount_pct, items!inner(sku, name, unit)')
    .eq('so_id', doData.sales_orders.id)
    .order('id');
  if (e2) { alert(e2.message); return; }

  // Render header
  document.getElementById('doInfo').innerHTML = `
    <div style="font-size:13px;">
      <b>${esc(doData.do_no)}</b> · SO ${esc(doData.sales_orders.so_no)} · ${esc(doData.sales_orders.partners.name)}
    </div>
  `;

  // Render lines
  const linesBody = document.getElementById('linesBody');
  const state = { lines: lines.map(l => ({
    line_id: l.id,
    item_id: l.item_id,
    sku: l.items.sku,
    name: l.display_name || l.items.name,
    original_name: l.display_name || l.items.name,
    qty: Number(l.qty),
    original_qty: Number(l.qty),
    unit: l.items.unit,
    unit_price: Number(l.unit_price),
    so_discount_pct: Number(l.so_discount_pct || 0)
  })) };

  const recalcTotal = () => {
    let total = 0;
    state.lines.forEach(l => {
      total += l.qty * l.unit_price * (1 - l.so_discount_pct/100);
    });
    document.getElementById('grandTotal').textContent = fmt(total);
  };

  const render = () => {
    linesBody.innerHTML = state.lines.map((l, i) => `
      <tr>
        <td>${esc(l.sku)}</td>
        <td>
          <input type="text" class="edit-name" data-i="${i}"
                 value="${esc(l.name)}" maxlength="100"
                 style="width:100%;padding:4px 6px;border:1px solid #d0d5dd;border-radius:5px;font-size:12px;">
        </td>
        <td class="num">
          <input type="number" class="edit-qty" data-i="${i}"
                 value="${l.qty}" min="0.0001" step="0.0001"
                 style="width:90px;padding:4px 6px;border:1px solid #d0d5dd;border-radius:5px;font-size:12px;text-align:right;">
        </td>
        <td>${esc(l.unit)}</td>
        <td class="num">${fmt(l.unit_price)}</td>
        <td class="num">${fmt(l.qty * l.unit_price * (1 - l.so_discount_pct/100))}</td>
      </tr>
    `).join('');

    linesBody.querySelectorAll('.edit-name').forEach(el => {
      el.addEventListener('input', e => {
        const i = Number(e.target.dataset.i);
        state.lines[i].name = e.target.value;
      });
    });
    linesBody.querySelectorAll('.edit-qty').forEach(el => {
      el.addEventListener('input', e => {
        const i = Number(e.target.dataset.i);
        state.lines[i].qty = Number(e.target.value) || 0;
        // Update subtotal cell di baris yang sama
        const tr = e.target.closest('tr');
        const subtotalCell = tr.querySelectorAll('td')[5];
        if (subtotalCell) {
          subtotalCell.textContent = fmt(state.lines[i].qty * state.lines[i].unit_price * (1 - state.lines[i].so_discount_pct/100));
        }
        recalcTotal();
      });
    });
    recalcTotal();
  };

  render();

  // Save
  document.getElementById('saveBtn').addEventListener('click', async () => {
    const payload = state.lines.map(l => ({
      line_id: l.line_id,
      qty: l.qty,
      display_name: l.name.trim() || l.original_name
    }));

    const { data, error } = await supabase.rpc('update_do_lines', {
      p_do_id: doId,
      p_lines: payload
    });

    if (error) { alert('Gagal: ' + error.message); return; }
    alert(`✓ DO diupdate: ${data.updated} baris`);
    window.location.href = './delivery.html';
  });

  document.getElementById('cancelBtn').addEventListener('click', () => {
    window.location.href = './delivery.html';
  });

  document.getElementById('backBtn').addEventListener('click', () => {
    window.location.href = './delivery.html';
  });
})();

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmt(n) { return 'Rp ' + Number(n || 0).toLocaleString('id-ID'); }