// js/master.js
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { listAccounts, createAccount } from './accounts.js';
import { listPartners, createPartner, updatePartner } from './partners.js';
import { listItems, createItem } from './items.js';

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => el.className = 'toast', 2500);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function fmtMoney(n) {
  return 'Rp ' + Number(n).toLocaleString('id-ID');
}

// ============================================================
// STATE
// ============================================================
const state = {
  role: null,
  editingPartnerId: null
};

const canEditPartner = () =>
  state.role === 'admin' || state.role === 'superadmin';

(async () => {
  const user = await requireAuth();
  if (!user) return;

  const role = await requirePageAccess('master');
  if (!role) return;
  state.role = role;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  await renderNav(document.getElementById('mainNav'), 'master');

  const tabs = document.querySelectorAll('.tabs button');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      document.getElementById('tab-' + btn.dataset.tab).style.display = 'block';
    });
  });

  await Promise.all([renderAccounts(), renderPartners(), renderItems()]);

  document.getElementById('form-account').addEventListener('submit', onSubmitAccount);
  document.getElementById('form-partner').addEventListener('submit', onSubmitPartner);
  document.getElementById('form-item').addEventListener('submit', onSubmitItem);

  document.getElementById('partnerCancelBtn').addEventListener('click', cancelEditPartner);
})();

async function renderAccounts() {
  const tb = document.getElementById('tbody-accounts');
  try {
    const rows = await listAccounts();
    tb.innerHTML = rows.map(a => `
      <tr>
        <td data-label="Kode">${esc(a.code)}</td>
        <td data-label="Nama">${esc(a.name)}</td>
        <td data-label="Tipe">${esc(a.type)}</td>
        <td data-label="Normal">${esc(a.normal_balance)}</td>
      </tr>
    `).join('') || `<tr><td colspan="4" style="text-align:center;color:#9ca3af;">Belum ada akun</td></tr>`;
  } catch (err) {
    toast('Gagal memuat akun: ' + err.message, true);
  }
}

async function renderPartners() {
  const tb = document.getElementById('tbody-partners');
  try {
    const rows = await listPartners();
    tb.innerHTML = rows.map(p => `
      <tr data-partner-id="${p.id}">
        <td data-label="Kode">${esc(p.code || '—')}</td>
        <td data-label="Nama">${esc(p.name)}</td>
        <td data-label="Tipe">${esc(p.type)}</td>
        <td data-label="Telepon">${esc(p.phone || '—')}</td>
        <td data-label="Email">${esc(p.email || '—')}</td>
        <td data-label="Aksi">
          ${canEditPartner()
            ? `<button class="btn btn-sm btn-edit-partner" data-id="${p.id}">Edit</button>`
            : `<span style="color:#9ca3af;">—</span>`}
        </td>
      </tr>
    `).join('') || `<tr><td colspan="6" style="text-align:center;color:#9ca3af;">Belum ada partner</td></tr>`;

    // Pasang handler tombol edit
    tb.querySelectorAll('.btn-edit-partner').forEach(btn => {
      btn.addEventListener('click', () => startEditPartner(Number(btn.dataset.id)));
    });
  } catch (err) {
    toast('Gagal memuat partner: ' + err.message, true);
  }
}

async function renderItems() {
  const tb = document.getElementById('tbody-items');
  try {
    const rows = await listItems();
    tb.innerHTML = rows.map(i => `
      <tr>
        <td data-label="SKU">${esc(i.sku)}</td>
        <td data-label="Nama">${esc(i.name)}</td>
        <td data-label="Satuan">${esc(i.unit)}</td>
        <td data-label="Stok">${Number(i.stock_qty).toLocaleString('id-ID')}</td>
        <td data-label="Avg Cost">${fmtMoney(i.avg_cost)}</td>
      </tr>
    `).join('') || `<tr><td colspan="5" style="text-align:center;color:#9ca3af;">Belum ada item</td></tr>`;
  } catch (err) {
    toast('Gagal memuat item: ' + err.message, true);
  }
}

async function onSubmitAccount(e) {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await createAccount({
      code: f.code.value.trim(),
      name: f.name.value.trim(),
      type: f.type.value,
      normal_balance: f.normal_balance.value
    });
    f.reset();
    await renderAccounts();
    toast('Akun berhasil disimpan');
  } catch (err) {
    toast('Gagal simpan akun: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
  }
}

async function startEditPartner(id) {
  try {
    const rows = await listPartners();
    const p = rows.find(x => x.id === id);
    if (!p) { toast('Partner tidak ditemukan', true); return; }

    const f = document.getElementById('form-partner');
    f.code.value = p.code || '';
    f.name.value = p.name || '';
    f.type.value = p.type || '';
    f.phone.value = p.phone || '';
    f.email.value = p.email || '';

    state.editingPartnerId = id;
    document.getElementById('partnerSubmitBtn').textContent = 'Simpan Perubahan';
    document.getElementById('partnerCancelBtn').style.display = 'inline-block';

    // Scroll ke form
    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    toast('Gagal memuat partner: ' + (err.message || err), true);
  }
}

function cancelEditPartner() {
  state.editingPartnerId = null;
  const f = document.getElementById('form-partner');
  f.reset();
  document.getElementById('partnerSubmitBtn').textContent = 'Simpan Partner';
  document.getElementById('partnerCancelBtn').style.display = 'none';
  toast('Edit dibatalkan');
}

async function onSubmitPartner(e) {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const payload = {
      code: f.code.value.trim() || null,
      name: f.name.value.trim(),
      type: f.type.value,
      phone: f.phone.value.trim() || null,
      email: f.email.value.trim() || null
    };

    if (state.editingPartnerId) {
      await updatePartner(state.editingPartnerId, payload);
      toast('Partner berhasil diperbarui');
    } else {
      await createPartner(payload);
      toast('Partner berhasil disimpan');
    }

    state.editingPartnerId = null;
    f.reset();
    document.getElementById('partnerSubmitBtn').textContent = 'Simpan Partner';
    document.getElementById('partnerCancelBtn').style.display = 'none';
    await renderPartners();
  } catch (err) {
    toast('Gagal simpan partner: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
  }
}

async function onSubmitItem(e) {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await createItem({
      sku: f.sku.value.trim(),
      name: f.name.value.trim(),
      unit: f.unit.value.trim() || 'pcs',
      min_stock: Number(f.min_stock.value) || 0
    });
    f.reset();
    f.unit.value = 'pcs';
    f.min_stock.value = 0;
    await renderItems();
    toast('Item berhasil disimpan');
  } catch (err) {
    toast('Gagal simpan item: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
  }
}