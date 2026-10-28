// js/kasir-page.js
import { requireAuth, logout, getSetting } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { listItems } from './items.js';
import { createCashSale, listCashSales } from './kasir.js';
import { supabase } from './supabase-client.js';

const state = {
  items: [],
  itemsById: {},
  lineCount: 0,
  ppnRate: 11
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

  const role = await requirePageAccess('kasir');
  if (!role) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  await renderNav(document.getElementById('mainNav'), 'kasir');

  const ppnStr = await getSetting('ppn_rate');
  state.ppnRate = Number(ppnStr) || 11;

  state.items = await listItems();
  state.itemsById = Object.fromEntries(state.items.map(i => [i.id, i]));

  document.querySelector('[name=cash_date]').value = new Date().toISOString().slice(0, 10);

  document.getElementById('addLineBtn').addEventListener('click', () => addLine());
  document.getElementById('resetBtn').addEventListener('click', resetForm);
  document.getElementById('form-cash').addEventListener('submit', onSubmit);

  addLine();
  await renderList();
})();

function addLine() {
  state.lineCount++;
  const id = state.lineCount;
  const wrap = document.getElementById('cashLines');
  const div = document.createElement('div');
  div.className = 'line-row';
  div.dataset.lineId = id;
  div.innerHTML = `
    <select class="line-item" required>
      <option value="">— pilih item —</option>
      ${state.items.map(i =>
        `<option value="${i.id}">${esc(i.sku)} — ${esc(i.name)} (stok: ${Number(i.stock_qty).toLocaleString('id-ID')})</option>`
      ).join('')}
    </select>
    <input type="number" class="line-qty" placeholder="Qty" min="0.0001" step="0.0001" required>
    <input type="number" class="line-price" placeholder="Harga" min="0" step="0.01" required>
    <div style="display:flex;align-items:center;font-size:13px;color:#6b7280;" class="line-subtotal">Rp 0</div>
    <button type="button" class="line-remove" title="Hapus">×</button>
  `;
  wrap.appendChild(div);

  div.querySelector('.line-remove').addEventListener('click', () => {
    div.remove();
    recalcTotals();
  });
  div.querySelectorAll('input').forEach(inp => inp.addEventListener('input', recalcTotals));
  recalcTotals();
}

function collectLines() {
  const rows = document.querySelectorAll('#cashLines .line-row');
  const lines = [];
  rows.forEach(r => {
    const item_id = Number(r.querySelector('.line-item').value) || null;
    const qty = Number(r.querySelector('.line-qty').value) || 0;
    const unit_price = Number(r.querySelector('.line-price').value) || 0;
    if (!item_id && !qty) return;
    lines.push({ item_id, qty, unit_price });
  });
  return lines;
}

function recalcTotals() {
  let total = 0;
  document.querySelectorAll('#cashLines .line-row').forEach(r => {
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
  document.getElementById('form-cash').reset();
  document.querySelector('[name=cash_date]').value = new Date().toISOString().slice(0, 10);
  document.getElementById('cashLines').innerHTML = '';
  state.lineCount = 0;
  addLine();
}

async function onSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  try {
    const lines = collectLines();
    if (lines.length === 0) throw new Error('Minimal 1 item');

    const cashId = await createCashSale({
      cash_date: f.cash_date.value,
      description: f.description.value.trim() || null,
      lines
    });
    toast(`✓ Transaksi tunai tersimpan (ID ${cashId})`);
    resetForm();
    state.items = await listItems();
    state.itemsById = Object.fromEntries(state.items.map(i => [i.id, i]));
    await renderList();
  } catch (err) {
    toast('Gagal: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan Transaksi';
  }
}

async function renderList() {
  const wrap = document.getElementById('cashList');
  wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Memuat...</div>';
  try {
    const list = await listCashSales({ limit: 30 });
    if (!list.length) {
      wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Belum ada transaksi.</div>';
      return;
    }
    wrap.innerHTML = list.map(c => `
      <div class="journal-list-item">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
          <div>
            <b>${esc(c.cash_no)}</b><br>
            <span style="font-size:13px;">${esc(c.description || '—')}</span>
          </div>
          <div style="text-align:right;font-size:13px;">
            <div>${fmt(c.grand_total)}</div>
            <div style="color:#6b7280;font-size:12px;">${c.cash_date}</div>
          </div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    wrap.innerHTML = `<div style="color:#b91c1c;font-size:13px;">${esc(err.message)}</div>`;
  }
}