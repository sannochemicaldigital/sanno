// js/sales-order-page.js
import { requireAuth, logout, getCurrentRole, getSetting } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { listPartners } from './partners.js';
import { listItems } from './items.js';
import { createSO, editSO, submitSO, cancelSO, getSO, listSOs } from './sales-order.js';
import { supabase } from './supabase-client.js';

const state = {
  partners: [],
  items: [],
  itemsById: {},
  lineCount: 0,
  editingId: null,
  ppnRate: 11,
  role: null
};

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => el.className = 'toast', 2800);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function fmt(n) { return 'Rp ' + Number(n || 0).toLocaleString('id-ID'); }

(async () => {
  const user = await requireAuth();
  if (!user) return;

  state.role = await requirePageAccess('sales-order');
  if (!state.role) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  await renderNav(document.getElementById('mainNav'), 'sales-order');

  const ppnStr = await getSetting('ppn_rate');
  state.ppnRate = Number(ppnStr) || 11;

  await loadMaster();

  document.querySelector('[name=so_date]').value = new Date().toISOString().slice(0, 10);

  document.getElementById('addLineBtn').addEventListener('click', () => addLine());
  document.getElementById('cancelBtn').addEventListener('click', resetForm);
  document.getElementById('form-so').addEventListener('submit', onSubmit);

  addLine();
  await renderSOList();
})();

async function loadMaster() {
  const [parts, its] = await Promise.all([
    listPartners('customer'),
    listItems()
  ]);
  state.items = its;
  state.itemsById = Object.fromEntries(its.map(i => [i.id, i]));

  let visiblePartners = parts;
  if (state.role === 'sales') {
    const { data: { session } } = await supabase.auth.getSession();
    const { data: rel } = await supabase
      .from('sales_partners').select('partner_id').eq('sales_id', session.user.id);
    const allowed = new Set((rel || []).map(r => r.partner_id));
    visiblePartners = parts.filter(p => allowed.has(p.id));
  }
  state.partners = visiblePartners;

  const sel = document.getElementById('partnerSelect');
  sel.innerHTML = '<option value="">— pilih pelanggan —</option>' +
    visiblePartners.map(p =>
      `<option value="${p.id}">${esc(p.code || '')} — ${esc(p.name)}</option>`
    ).join('');
}

function addLine() {
  state.lineCount++;
  const id = state.lineCount;
  const wrap = document.getElementById('soLines');
  const div = document.createElement('div');
  div.className = 'line-row';
  div.dataset.lineId = id;
  div.innerHTML = `
    <select class="line-item" data-field="item_id" required>
      <option value="">— pilih item —</option>
      ${state.items.map(i =>
        `<option value="${i.id}">${esc(i.sku)} — ${esc(i.name)}</option>`
      ).join('')}
    </select>
    <input type="number" class="line-qty" data-field="qty" placeholder="Qty" min="0.0001" step="0.0001" required>
    <input type="number" class="line-price" data-field="unit_price" placeholder="Harga satuan" min="0" step="0.01" required>
    <div style="display:flex;align-items:center;font-size:13px;color:#6b7280;" class="line-subtotal">Rp 0</div>
    <button type="button" class="line-remove" title="Hapus">×</button>
  `;
  wrap.appendChild(div);

  div.querySelector('.line-remove').addEventListener('click', () => {
    div.remove();
    recalcTotals();
  });
  div.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', recalcTotals);
  });
  recalcTotals();
}

function collectLines() {
  const rows = document.querySelectorAll('#soLines .line-row');
  const lines = [];
  rows.forEach(r => {
    const item_id = Number(r.querySelector('.line-item').value) || null;
    const qty = Number(r.querySelector('.line-qty').value) || 0;
    const unit_price = Number(r.querySelector('.line-price').value) || 0;
    if (!item_id && !qty) return;
    lines.push({ item_id, qty, unit_price, memo: null });
  });
  return lines;
}

function recalcTotals() {
  let total = 0;
  document.querySelectorAll('#soLines .line-row').forEach(r => {
    const qty = Number(r.querySelector('.line-qty').value) || 0;
    const price = Number(r.querySelector('.line-price').value) || 0;
    const sub = qty * price;
    total += sub;
    r.querySelector('.line-subtotal').textContent = fmt(sub);
  });
  const ppn = total * state.ppnRate / 100;
  const grand = total + ppn;
  document.getElementById('totalAmount').textContent = fmt(total);
  document.getElementById('ppnInfo').innerHTML =
    `PPN ${state.ppnRate}%: ${fmt(ppn)} · Grand Total: <b>${fmt(grand)}</b>`;
}

function resetForm() {
  document.getElementById('form-so').reset();
  document.querySelector('[name=so_date]').value = new Date().toISOString().slice(0, 10);
  document.getElementById('soLines').innerHTML = '';
  state.lineCount = 0;
  state.editingId = null;
  document.getElementById('formTitle').textContent = 'Sales Order Baru';
  document.getElementById('saveBtn').textContent = 'Simpan Draft';
  document.getElementById('cancelBtn').style.display = 'none';
  addLine();
}

async function onSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = state.editingId ? 'Mengupdate...' : 'Menyimpan...';
  try {
    const lines = collectLines();
    if (lines.length === 0) throw new Error('Minimal 1 item');

    const payload = {
      so_date: f.so_date.value,
      partner_id: Number(f.partner_id.value),
      description: f.description.value.trim() || null,
      lines
    };

    if (state.editingId) {
      await editSO(state.editingId, payload);
      toast('✓ SO diupdate');
    } else {
      const soId = await createSO(payload);
      toast(`✓ SO dibuat (ID ${soId})`);
    }
    resetForm();
    await renderSOList();
  } catch (err) {
    toast('Gagal: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = state.editingId ? 'Update Draft' : 'Simpan Draft';
  }
}

async function renderSOList() {
  const wrap = document.getElementById('soList');
  wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Memuat...</div>';
  try {
    const list = await listSOs({ limit: 50 });
    if (!list.length) {
      wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Belum ada SO.</div>';
      return;
    }
    const statusBadge = s => {
      const colors = {
        draft:            '#e5e7eb|#374151',
        pending_approval: '#fef3c7|#92400e',
        approved:         '#dbeafe|#1e40af',
        rejected:         '#fee2e2|#991b1b',
        cancelled:        '#f3f4f6|#6b7280',
        delivered:        '#d1fae5|#065f46',
        posted:           '#d1fae5|#065f46'
      };
      const [bg, fg] = (colors[s] || '#e5e7eb|#374151').split('|');
      return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase;">${esc(s)}</span>`;
    };

    wrap.innerHTML = list.map(so => {
      const actions = [];
      if (so.status === 'draft') {
        actions.push(`<button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" data-edit="${so.id}">Edit</button>`);
        actions.push(`<button class="btn btn-primary" style="padding:4px 10px;font-size:12px;" data-submit="${so.id}">Submit Approval</button>`);
        actions.push(`<button class="btn btn-danger" style="padding:4px 10px;font-size:12px;" data-cancel="${so.id}">Batal</button>`);
      }
      const actHtml = actions.length
        ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${actions.join('')}</div>`
        : '';

      return `
        <div class="journal-list-item">
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <div>
              <b>${esc(so.so_no)}</b> ${statusBadge(so.status)}<br>
              <span style="font-size:13px;">${esc(so.partners?.name || '')}</span>
            </div>
            <div style="text-align:right;font-size:13px;">
              <div>${fmt(so.grand_total)}</div>
              <div style="color:#6b7280;font-size:12px;">${so.so_date}</div>
            </div>
          </div>
          ${actHtml}
        </div>`;
    }).join('');

    wrap.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => onEdit(Number(btn.dataset.edit)));
    });
    wrap.querySelectorAll('[data-submit]').forEach(btn => {
      btn.addEventListener('click', () => onSubmitApproval(Number(btn.dataset.submit)));
    });
    wrap.querySelectorAll('[data-cancel]').forEach(btn => {
      btn.addEventListener('click', () => onCancel(Number(btn.dataset.cancel)));
    });
  } catch (err) {
    wrap.innerHTML = `<div style="color:#b91c1c;font-size:13px;">${esc(err.message)}</div>`;
  }
}

async function onEdit(soId) {
  try {
    const so = await getSO(soId);
    if (so.status !== 'draft') throw new Error('Hanya draft yang bisa diedit');
    state.editingId = soId;

    const f = document.getElementById('form-so');
    f.so_date.value = so.so_date;
    f.partner_id.value = so.partner_id;
    f.description.value = so.description || '';

    document.getElementById('soLines').innerHTML = '';
    state.lineCount = 0;
    for (const l of so.lines) {
      addLine();
      const row = document.querySelector(`#soLines .line-row[data-line-id="${state.lineCount}"]`);
      row.querySelector('.line-item').value = l.item_id;
      row.querySelector('.line-qty').value = l.qty;
      row.querySelector('.line-price').value = l.unit_price;
    }
    recalcTotals();

    document.getElementById('formTitle').textContent = `Edit SO — ${so.so_no}`;
    document.getElementById('saveBtn').textContent = 'Update Draft';
    document.getElementById('cancelBtn').style.display = 'inline-block';
    f.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    toast('Gagal muat: ' + err.message, true);
  }
}

async function onSubmitApproval(soId) {
  if (!confirm('Submit SO ini untuk approval?')) return;
  try {
    await submitSO(soId);
    toast('✓ SO submitted untuk approval');
    await renderSOList();
  } catch (err) {
    toast('Gagal submit: ' + (err.message || err), true);
  }
}

async function onCancel(soId) {
  const reason = prompt('Alasan batal:');
  if (!reason) return;
  try {
    await cancelSO(soId, reason);
    toast('✓ SO dibatalkan');
    await renderSOList();
  } catch (err) {
    toast('Gagal batal: ' + (err.message || err), true);
  }
}