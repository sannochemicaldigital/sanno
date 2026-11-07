// js/delivery-edit-page.js
import { requireAuth } from './auth.js';
import { hasPermission } from './permissions.js';
import { supabase } from './supabase-client.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));
const fmt = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => el.className = 'toast', 2600);
}

(async () => {
  const user = await requireAuth();
  if (!user) return;

  const canEdit = await hasPermission('delivery.edit_display_name');
  if (!canEdit) {
    alert('Tidak ada akses edit nama DO');
    window.location.href = './delivery.html';
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const doId = Number(params.get('id'));
  if (!doId) {
    alert('Parameter ?id= wajib di URL');
    return;
  }

  // Fetch DO + SO + partner
  const { data: doData, error: e1 } = await supabase
    .from('delivery_orders')
    .select(`
      id, do_no, do_date, status, so_id,
      sales_orders!inner(
        id, so_no,
        partners!inner(name)
      )
    `)
    .eq('id', doId)
    .single();
  if (e1) { alert('Gagal load DO: ' + e1.message); return; }

  if (doData.status !== 'issued') {
    alert(`Edit hanya bisa saat DO issued. Status sekarang: ${doData.status}`);
    window.location.href = './delivery.html';
    return;
  }

  // Fetch lines
  const { data: lines, error: e2 } = await supabase
    .from('sales_order_lines')
    .select(`
      id, item_id, qty, unit_price, display_name, display_name_source,
      items!inner(sku, name, nama_beli, nama_jual)
    `)
    .eq('so_id', doData.so_id)
    .order('id');
  if (e2) { alert('Gagal load lines: ' + e2.message); return; }

  // Header info
  document.getElementById('doInfo').innerHTML = `
    <b>${esc(doData.do_no)}</b> · SO ${esc(doData.sales_orders.so_no)} ·
    ${esc(doData.sales_orders.partners.name)} ·
    <span style="color:#6b7280;">Tanggal: ${esc(doData.do_date)}</span>
  `;

  // State
  const state = {
    lines: (lines || []).map(l => ({
      line_id: l.id,
      sku: l.items.sku,
      item_name: l.items.name,
      nama_beli: l.items.nama_beli,
      nama_jual: l.items.nama_jual,
      original_name: l.display_name || l.items.name || l.items.nama_beli || '',
      new_name: l.display_name || l.items.name || l.items.nama_beli || '',
      qty: Number(l.qty),
      unit_price: Number(l.unit_price)
    }))
  };

  const tbody = document.getElementById('linesBody');
  const saveBtn = document.getElementById('saveBtn');
  const dirtyInfo = document.getElementById('dirtyInfo');

  const recomputeDirty = () => {
    const changed = state.lines.filter(l =>
      l.new_name.trim() && l.new_name.trim() !== l.original_name
    );
    saveBtn.disabled = changed.length === 0;
    dirtyInfo.textContent = changed.length
      ? `${changed.length} nama akan diubah`
      : '';
  };

  // Render
  tbody.innerHTML = state.lines.map((l, i) => `
    <tr data-i="${i}">
      <td style="font-family:'Courier New',monospace;font-size:12px;">${esc(l.sku)}</td>
      <td style="font-size:12px;color:#6b7280;">
        ${esc(l.original_name)}
        ${l.nama_jual && l.nama_jual !== l.nama_beli
          ? `<br><span style="font-size:11px;color:#9ca3af;">jual: ${esc(l.nama_jual)}</span>` : ''}
      </td>
      <td>
        <input type="text" class="edit-name" data-i="${i}"
               value="${esc(l.new_name)}" maxlength="100"
               placeholder="${esc(l.original_name)}"
               style="width:100%;padding:6px 8px;border:1px solid #d0d5dd;border-radius:5px;font-size:12px;">
      </td>
      <td class="num">${l.qty.toLocaleString('id-ID')}</td>
      <td class="num">${fmt(l.unit_price)}</td>
    </tr>
  `).join('');

  // Wire input
  tbody.querySelectorAll('.edit-name').forEach(inp => {
    inp.addEventListener('input', e => {
      const i = Number(e.target.dataset.i);
      state.lines[i].new_name = e.target.value;
      recomputeDirty();
    });
  });

  recomputeDirty();

  // Save
  saveBtn.addEventListener('click', async () => {
    const changed = state.lines.filter(l =>
      l.new_name.trim() && l.new_name.trim() !== l.original_name
    );
    if (!changed.length) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Menyimpan...';

    let ok = 0, fail = 0;
    const errors = [];

    for (const l of changed) {
      try {
        const { error } = await supabase.rpc('update_do_line_display_name', {
          p_line_id: l.line_id,
          p_display_name: l.new_name.trim()
        });
        if (error) throw error;
        l.original_name = l.new_name.trim();
        ok++;
      } catch (err) {
        fail++;
        errors.push(`${l.sku}: ${err.message || err}`);
      }
    }

    saveBtn.disabled = false;
    saveBtn.textContent = 'Simpan Perubahan';

    if (fail === 0) {
      toast(`✓ ${ok} nama berhasil diubah`);
      recomputeDirty();
    } else {
      toast(`⚠ ${ok} berhasil, ${fail} gagal`, true);
      alert('Gagal:\n' + errors.join('\n'));
      recomputeDirty();
    }
  });

  // Cancel
  document.getElementById('cancelBtn').addEventListener('click', () => {
    if (confirm('Batalkan perubahan? Perubahan yang belum disimpan akan hilang.')) {
      window.close();
    }
  });

  // Close (topbar)
  document.getElementById('closeBtn').addEventListener('click', () => {
    window.close();
  });
})();