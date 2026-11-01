// js/sales-order-page.js
import { requireAuth, logout, getCurrentRole, getSetting } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission } from './permissions.js';
import { listPartners } from './partners.js';
import { listItems } from './items.js';
import {
  createSO, editSO, submitSO, cancelSO, getSO, listSOs, getPriceForItem
} from './sales-order.js';
import { supabase } from './supabase-client.js';

// ============================================================
// STATE
// ============================================================
const state = {
  partners: [],
  items: [],
  itemsById: {},
  lineCount: 0,
  editingId: null,
  ppnRate: 11,
  role: null,
  perms: { create: false, edit: false, submit: false, cancel: false }
};

// ============================================================
// UTIL
// ============================================================
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
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

// ============================================================
// INIT
// ============================================================
(async () => {
  const user = await requireAuth();
  if (!user) return;

  state.role = await requirePageAccess('sales-order');
  if (!state.role) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  await renderNav(document.getElementById('mainNav'), 'sales-order');

  state.perms.create = await hasPermission('sales.order.create');
  state.perms.edit   = await hasPermission('sales.order.edit');
  state.perms.submit = await hasPermission('sales.order.submit');
  state.perms.cancel = await hasPermission('sales.order.cancel');

  if (!state.perms.create) {
    document.getElementById('form-so').style.display = 'none';
    document.getElementById('formTitle').textContent = 'Tidak ada akses membuat SO';
  } else {
    const ppnStr = await getSetting('ppn_rate');
    state.ppnRate = Number(ppnStr) || 11;
    await loadMaster();
    document.querySelector('[name=so_date]').value = new Date().toISOString().slice(0, 10);
    document.getElementById('addLineBtn').addEventListener('click', () => addLine());
    document.getElementById('cancelBtn').addEventListener('click', resetForm);
    document.getElementById('form-so').addEventListener('submit', onSubmit);
    // Baris awal
    addLine();
  }

  await renderSOList();
})();

// ============================================================
// LOAD MASTER
// ============================================================
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

// ============================================================
// BARIS ITEM
// ============================================================
function addLine() {
  state.lineCount++;
  const tbody = document.getElementById('soLines');
  // Hapus placeholder kalau ada
  const ph = tbody.querySelector('.so-line-placeholder');
  if (ph) ph.remove();

  const tr = document.createElement('tr');
  tr.className = 'so-line-row';
  tr.dataset.lineId = state.lineCount;
  tr.innerHTML = `
    <td>
      <select class="line-item" required>
        <option value="">— pilih item —</option>
        ${state.items.map(i =>
          `<option value="${i.id}">${esc(i.sku)} — ${esc(i.name)}</option>`
        ).join('')}
      </select>
    </td>
    <td class="num">
      <input type="number" class="line-qty" placeholder="0" min="0.0001" step="0.0001" required
             style="text-align:right;">
    </td>
    <td class="num">
      <input type="text" class="pl-readonly" placeholder="—" readonly tabindex="-1">
    </td>
    <td class="num">
      <input type="number" class="line-price" placeholder="0" min="0" step="0.01" required
             style="text-align:right;">
    </td>
    <td class="num">
      <input type="number" class="line-disc" placeholder="0" min="0" max="100" step="0.01"
             value="0" style="text-align:right;">
    </td>
    <td class="num">
      <input type="text" class="line-eff" placeholder="0" readonly tabindex="-1">
    </td>
    <td class="line-status">
      <span class="so-badge ok" style="display:none;">—</span>
    </td>
    <td>
      <input type="text" class="line-override-reason" placeholder="—" maxlength="200" disabled>
    </td>
    <td>
      <button type="button" class="line-remove" title="Hapus">×</button>
    </td>
  `;
  tbody.appendChild(tr);

  // Bind events
  tr.querySelector('.line-item').addEventListener('change', onItemChange);
  tr.querySelector('.line-qty').addEventListener('input', recalcTotals);
  tr.querySelector('.line-price').addEventListener('input', () => {
    recalcLine(tr);
    recalcTotals();
  });
  tr.querySelector('.line-disc').addEventListener('input', () => {
    recalcLine(tr);
    recalcTotals();
  });
  tr.querySelector('.line-remove').addEventListener('click', () => {
    tr.remove();
    recalcTotals();
  });

  recalcLine(tr);
  recalcTotals();
}

// Saat item dipilih → ambil harga price list + auto-isi
async function onItemChange(e) {
  const tr = e.target.closest('tr');
  const itemId = Number(e.target.value) || 0;
  if (!itemId) {
    tr.querySelector('.pl-readonly').value = '';
    tr.querySelector('.line-price').value = '';
    tr.querySelector('.line-eff').value = '';
    recalcLine(tr);
    recalcTotals();
    return;
  }

  try {
    const pl = await getPriceForItem(itemId);
    const plPriceEl = tr.querySelector('.pl-readonly');
    const priceEl = tr.querySelector('.line-price');

    if (!pl || pl.has_price === false) {
      // Item belum punya price list (D7 — tidak boleh dijual)
      plPriceEl.value = '—';
      plPriceEl.title = 'Item belum punya price list';
      tr.dataset.hasPrice = 'false';
      // Jangan auto-isi harga; biarkan sales sadar
      if (!priceEl.value) priceEl.value = '';
      recalcLine(tr);
      recalcTotals();
      return;
    }

    tr.dataset.hasPrice = 'true';
    tr.dataset.plPrice = pl.price;
    tr.dataset.plDiscount = pl.discount_pct;
    tr.dataset.plEffective = pl.effective_price;

    plPriceEl.value = fmt(pl.effective_price);
    plPriceEl.title = `Harga: ${fmt(pl.price)} · Diskon: ${pl.discount_pct}%`;

    // Auto-isi harga diajukan dari effective_price (sales bisa ubah)
    if (!priceEl.value || Number(priceEl.value) === 0) {
      priceEl.value = pl.effective_price;
    }

    recalcLine(tr);
    recalcTotals();
  } catch (err) {
    console.error('getPriceForItem:', err);
    toast('Gagal ambil harga price list: ' + (err.message || err), true);
  }
}

// Hitung harga efektif + badge selisih per baris
function recalcLine(tr) {
  const hasPrice = tr.dataset.hasPrice === 'true';
  const plEff = hasPrice ? Number(tr.dataset.plEffective) : null;

  const qty = Number(tr.querySelector('.line-qty').value) || 0;
  const price = Number(tr.querySelector('.line-price').value) || 0;
  const disc = Number(tr.querySelector('.line-disc').value) || 0;
  const eff = price * (1 - disc / 100);

  const effEl = tr.querySelector('.line-eff');
  effEl.value = eff > 0 ? fmt(eff) : '0';

  const badgeEl = tr.querySelector('.line-status .so-badge');
  const reasonEl = tr.querySelector('.line-override-reason');

  // Default: sembunyikan badge
  badgeEl.style.display = 'none';
  badgeEl.className = 'so-badge';

  if (!hasPrice) {
    // Belum ada PL atau belum pilih item
    if (tr.querySelector('.line-item').value) {
      badgeEl.textContent = '⚠ Belum ada PL';
      badgeEl.className = 'so-badge no-pl';
      badgeEl.style.display = 'inline-block';
    }
    reasonEl.disabled = true;
    reasonEl.value = '';
    return;
  }

  // Ada PL — hitung selisih
  const diff = eff - plEff;
  const diffPct = plEff > 0 ? (diff / plEff) * 100 : 0;

  if (Math.abs(diff) < 0.01) {
    // Sesuai
    badgeEl.textContent = '✓ Sesuai';
    badgeEl.className = 'so-badge ok';
    badgeEl.style.display = 'inline-block';
    reasonEl.disabled = true;
    reasonEl.value = '';
  } else if (diff < 0) {
    // Di bawah PL — butuh approval
    badgeEl.textContent = `−${Math.abs(diffPct).toFixed(1)}%`;
    badgeEl.className = 'so-badge pending';
    badgeEl.style.display = 'inline-block';
    badgeEl.title = `Di bawah price list: ${fmt(diff)} (${diffPct.toFixed(2)}%). Butuh approval.`;
    reasonEl.disabled = false;
  } else {
    // Di atas PL — butuh approval
    badgeEl.textContent = `+${diffPct.toFixed(1)}%`;
    badgeEl.className = 'so-badge pending';
    badgeEl.style.display = 'inline-block';
    badgeEl.title = `Di atas price list: ${fmt(diff)} (${diffPct.toFixed(2)}%). Butuh approval.`;
    reasonEl.disabled = false;
  }
}

// ============================================================
// COLLECT LINES
// ============================================================
function collectLines() {
  const rows = document.querySelectorAll('#soLines .so-line-row');
  const lines = [];
  rows.forEach(r => {
    const item_id = Number(r.querySelector('.line-item').value) || null;
    const qty = Number(r.querySelector('.line-qty').value) || 0;
    const unit_price = Number(r.querySelector('.line-price').value) || 0;
    const so_discount_pct = Number(r.querySelector('.line-disc').value) || 0;
    const reason = r.querySelector('.line-override-reason').value.trim() || null;
    if (!item_id && !qty) return;
    lines.push({
      item_id,
      qty,
      unit_price,
      so_discount_pct,
      price_override_reason: reason,
      memo: null
    });
  });
  return lines;
}

// ============================================================
// RECALC TOTAL
// ============================================================
function recalcTotals() {
  let total = 0;
  document.querySelectorAll('#soLines .so-line-row').forEach(r => {
    const qty = Number(r.querySelector('.line-qty').value) || 0;
    const price = Number(r.querySelector('.line-price').value) || 0;
    const disc = Number(r.querySelector('.line-disc').value) || 0;
    const sub = qty * price * (1 - disc / 100);
    total += sub;
  });
  const ppn = total * state.ppnRate / 100;
  const grand = total + ppn;
  document.getElementById('totalAmount').textContent = fmt(total);
  document.getElementById('ppnInfo').innerHTML =
    `PPN ${state.ppnRate}%: ${fmt(ppn)} · Grand Total: <b>${fmt(grand)}</b>`;
}

// ============================================================
// RESET FORM
// ============================================================
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

// ============================================================
// SUBMIT
// ============================================================
async function onSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const btn = document.getElementById('saveBtn');
  const isEditing = state.editingId !== null;

  if (isEditing && !state.perms.edit) { toast('Tidak ada akses edit SO', true); return; }
  if (!isEditing && !state.perms.create) { toast('Tidak ada akses buat SO', true); return; }

  btn.disabled = true;
  btn.textContent = isEditing ? 'Mengupdate...' : 'Menyimpan...';
  try {
    const lines = collectLines();
    if (lines.length === 0) throw new Error('Minimal 1 item');

    // Blokir kalau ada item tanpa price list (D7 — backend juga akan RAISE)
    const rows = document.querySelectorAll('#soLines .so-line-row');
    for (const r of rows) {
      const itemId = Number(r.querySelector('.line-item').value);
      if (!itemId) continue;
      if (r.dataset.hasPrice === 'false') {
        const it = state.itemsById[itemId];
        throw new Error(
          `Item ${it?.sku || itemId} belum punya price list. Tidak bisa dijual.`
        );
      }
    }

    const payload = {
      so_date: f.so_date.value,
      partner_id: Number(f.partner_id.value),
      description: f.description.value.trim() || null,
      payment_terms_days: Number(f.payment_terms_days.value) || 30,
      lines
    };

    if (isEditing) {
      await editSO(state.editingId, payload);
      toast('✓ SO diupdate');
    } else {
      const result = await createSO(payload);
      toast(`✓ SO ${result.so_no} dibuat (draft)`);
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

// ============================================================
// DAFTAR SO
// ============================================================
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
        if (state.perms.edit)   actions.push(`<button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" data-edit="${so.id}">Edit</button>`);
        if (state.perms.submit) actions.push(`<button class="btn btn-primary" style="padding:4px 10px;font-size:12px;" data-submit="${so.id}">Submit Approval</button>`);
        if (state.perms.cancel) actions.push(`<button class="btn btn-danger" style="padding:4px 10px;font-size:12px;" data-cancel="${so.id}">Batal</button>`);
      }
      if (so.status === 'posted') {
        actions.push(`<button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" data-invoice="${so.id}">🖨 Invoice</button>`);
      }
      const actHtml = actions.length
        ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${actions.join('')}</div>`
        : '';

      const terms = so.payment_terms_days ?? 30;
      const dueDate = so.due_date || '—';

      return `
        <div class="journal-list-item">
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <div>
              <b>${esc(so.so_no)}</b> ${statusBadge(so.status)}<br>
              <span style="font-size:13px;">${esc(so.partners?.name || '')}</span><br>
              <span style="font-size:11px;color:#6b7280;">
                Jatuh tempo: ${terms} hari · Due: ${fmtDate(dueDate)}
              </span>
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
    wrap.querySelectorAll('[data-invoice]').forEach(btn => {
      btn.addEventListener('click', () => onInvoice(Number(btn.dataset.invoice)));
    });
  } catch (err) {
    wrap.innerHTML = `<div style="color:#b91c1c;font-size:13px;">${esc(err.message)}</div>`;
  }
}

// ============================================================
// EDIT SO
// ============================================================
async function onEdit(soId) {
  if (!state.perms.edit) { toast('Tidak ada akses edit SO', true); return; }
  try {
    const so = await getSO(soId);
    if (so.status !== 'draft') throw new Error('Hanya draft yang bisa diedit');
    state.editingId = soId;

    const f = document.getElementById('form-so');
    f.so_date.value = so.so_date;
    f.partner_id.value = so.partner_id;
    f.description.value = so.description || '';
    f.payment_terms_days.value = String(so.payment_terms_days ?? 30);

    document.getElementById('soLines').innerHTML = '';
    state.lineCount = 0;

    for (const l of so.lines) {
      addLine();
      const row = document.querySelector(`#soLines .so-line-row[data-line-id="${state.lineCount}"]`);
      // Set dataset dari snapshot existing
      if (l.price_list_price != null) {
        row.dataset.hasPrice = 'true';
        row.dataset.plPrice = l.price_list_price;
        row.dataset.plDiscount = l.price_list_discount_pct;
        row.dataset.plEffective = l.price_list_effective_price;
        row.querySelector('.pl-readonly').value = fmt(l.price_list_effective_price);
        row.querySelector('.pl-readonly').title =
          `Harga: ${fmt(l.price_list_price)} · Diskon: ${l.price_list_discount_pct || 0}%`;
      } else {
        row.dataset.hasPrice = 'false';
        row.querySelector('.pl-readonly').value = '—';
      }
      row.querySelector('.line-item').value = l.item_id;
      row.querySelector('.line-qty').value = l.qty;
      row.querySelector('.line-price').value = l.unit_price;
      row.querySelector('.line-disc').value = l.so_discount_pct || 0;
      row.querySelector('.line-override-reason').value = l.price_override_reason || '';
      recalcLine(row);
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

// ============================================================
// SUBMIT APPROVAL
// ============================================================
async function onSubmitApproval(soId) {
  if (!state.perms.submit) { toast('Tidak ada akses submit', true); return; }
  if (!confirm('Submit SO ini untuk approval?')) return;
  try {
    await submitSO(soId);
    toast('✓ SO submitted untuk approval');
    await renderSOList();
  } catch (err) {
    toast('Gagal submit: ' + (err.message || err), true);
  }
}

// ============================================================
// CANCEL
// ============================================================
async function onCancel(soId) {
  if (!state.perms.cancel) { toast('Tidak ada akses batal SO', true); return; }
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

// ============================================================
// INVOICE
// ============================================================
function onInvoice(soId) {
  window.open(`./invoice-print.html?id=${soId}`, '_blank');
}