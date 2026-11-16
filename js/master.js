// js/master.js
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { listAccounts, createAccount, updateAccount } from './accounts.js';
import { listPartners, createPartner, updatePartner } from './partners.js';
import { listItems, createItem } from './items.js';
import { listProfiles, updateProfile } from './profiles.js';

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
// AUTO-FORMAT KODE AKUN
// "11140" -> "1-1140", "1-1140" tetap "1-1140"
// ============================================================
function normalizeAccountCode(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (s.includes('-')) return s;
  if (/^\d{5}$/.test(s)) return s[0] + '-' + s.slice(1);
  return s;
}

// ============================================================
// STATE
// ============================================================
const state = {
  role: null,
  editingPartnerId: null,
  editingAccountId: null,
  editingUserId: null
};

const canEdit = () =>
  state.role === 'admin' || state.role === 'superadmin';

(async () => {
  const user = await requireAuth();
  if (!user) return;

  const role = await requirePageAccess('master');
  if (!role) return;
  state.role = role;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  await renderNav(document.getElementById('mainNav'), 'master');

  // Sembunyikan tab User untuk role selain admin/superadmin
  if (!canEdit()) {
    const userTabBtn = document.querySelector('.tabs button[data-tab="user"]');
    if (userTabBtn) userTabBtn.style.display = 'none';
  }

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
  if (canEdit()) await renderUsers();

  document.getElementById('form-account').addEventListener('submit', onSubmitAccount);
  document.getElementById('form-partner').addEventListener('submit', onSubmitPartner);
  document.getElementById('form-item').addEventListener('submit', onSubmitItem);
  document.getElementById('form-user').addEventListener('submit', onSubmitUser);

  document.getElementById('partnerCancelBtn').addEventListener('click', cancelEditPartner);
  document.getElementById('accountCancelBtn').addEventListener('click', cancelEditAccount);
  document.getElementById('userCancelBtn').addEventListener('click', cancelEditUser);

  // Auto-format kode akun saat blur (ketik 11140 -> 1-1140)
  document.getElementById('form-account').code.addEventListener('blur', (e) => {
    e.target.value = normalizeAccountCode(e.target.value);
  });
})();

// ============================================================
// ACCOUNTS
// ============================================================
async function renderAccounts() {
  const tb = document.getElementById('tbody-accounts');
  try {
    const rows = await listAccounts();
    tb.innerHTML = rows.map(a => `
      <tr data-account-id="${a.id}">
        <td data-label="Kode">${esc(a.code)}</td>
        <td data-label="Nama">${esc(a.name)}</td>
        <td data-label="Tipe">${esc(a.type)}</td>
        <td data-label="Normal">${esc(a.normal_balance)}</td>
        <td data-label="Aksi">
          ${canEdit()
            ? `<button class="btn btn-sm btn-edit-account" data-id="${a.id}">Edit</button>`
            : `<span style="color:#9ca3af;">—</span>`}
        </td>
      </tr>
    `).join('') || `<tr><td colspan="5" style="text-align:center;color:#9ca3af;">Belum ada akun</td></tr>`;

    tb.querySelectorAll('.btn-edit-account').forEach(btn => {
      btn.addEventListener('click', () => startEditAccount(Number(btn.dataset.id)));
    });
  } catch (err) {
    toast('Gagal memuat akun: ' + err.message, true);
  }
}

async function startEditAccount(id) {
  try {
    const rows = await listAccounts();
    const a = rows.find(x => x.id === id);
    if (!a) { toast('Akun tidak ditemukan', true); return; }

    const f = document.getElementById('form-account');
    f.code.value = a.code || '';
    f.name.value = a.name || '';
    f.type.value = a.type || '';
    f.normal_balance.value = a.normal_balance || 'D';
    f.code.disabled = true;

    state.editingAccountId = id;
    document.getElementById('accountSubmitBtn').textContent = 'Simpan Perubahan';
    document.getElementById('accountCancelBtn').style.display = 'inline-block';

    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    toast('Gagal memuat akun: ' + (err.message || err), true);
  }
}

function cancelEditAccount() {
  state.editingAccountId = null;
  const f = document.getElementById('form-account');
  f.reset();
  f.code.disabled = false;
  document.getElementById('accountSubmitBtn').textContent = 'Simpan Akun';
  document.getElementById('accountCancelBtn').style.display = 'none';
  toast('Edit dibatalkan');
}

async function onSubmitAccount(e) {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    if (state.editingAccountId) {
      await updateAccount(state.editingAccountId, {
        name: f.name.value.trim(),
        type: f.type.value,
        normal_balance: f.normal_balance.value
      });
      toast('Akun berhasil diperbarui');
    } else {
      await createAccount({
        code: normalizeAccountCode(f.code.value),
        name: f.name.value.trim(),
        type: f.type.value,
        normal_balance: f.normal_balance.value
      });
      toast('Akun berhasil disimpan');
    }
    state.editingAccountId = null;
    f.reset();
    f.code.disabled = false;
    document.getElementById('accountSubmitBtn').textContent = 'Simpan Akun';
    document.getElementById('accountCancelBtn').style.display = 'none';
    await renderAccounts();
  } catch (err) {
    toast('Gagal simpan akun: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
  }
}

// ============================================================
// PARTNERS
// ============================================================
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
          ${canEdit()
            ? `<button class="btn btn-sm btn-edit-partner" data-id="${p.id}">Edit</button>`
            : `<span style="color:#9ca3af;">—</span>`}
        </td>
      </tr>
    `).join('') || `<tr><td colspan="6" style="text-align:center;color:#9ca3af;">Belum ada partner</td></tr>`;

    tb.querySelectorAll('.btn-edit-partner').forEach(btn => {
      btn.addEventListener('click', () => startEditPartner(Number(btn.dataset.id)));
    });
  } catch (err) {
    toast('Gagal memuat partner: ' + err.message, true);
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

// ============================================================
// ITEMS
// ============================================================
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

// ============================================================
// USERS
// ============================================================
async function renderUsers() {
  const tb = document.getElementById('tbody-users');
  if (!tb) return;
  try {
    const rows = await listProfiles();
    tb.innerHTML = rows.map(u => `
      <tr data-user-id="${u.id}">
        <td data-label="Email">${esc(u.email)}</td>
        <td data-label="Nama">${esc(u.full_name || '—')}</td>
        <td data-label="Role">${esc(u.role || '—')}</td>
        <td data-label="Status">
          ${u.is_active
            ? '<span style="color:#059669;font-weight:600;">Aktif</span>'
            : '<span style="color:#b91c1c;font-weight:600;">Nonaktif</span>'}
        </td>
        <td data-label="Aksi">
          <button class="btn btn-sm btn-edit-user" data-id="${u.id}">Edit</button>
        </td>
      </tr>
    `).join('') || `<tr><td colspan="5" style="text-align:center;color:#9ca3af;">Belum ada user</td></tr>`;

    tb.querySelectorAll('.btn-edit-user').forEach(btn => {
      btn.addEventListener('click', () => startEditUser(btn.dataset.id));
    });
  } catch (err) {
    toast('Gagal memuat user: ' + err.message, true);
  }
}

async function startEditUser(id) {
  try {
    const rows = await listProfiles();
    const u = rows.find(x => x.id === id);
    if (!u) { toast('User tidak ditemukan', true); return; }

    const f = document.getElementById('form-user');
    f.email.value = u.email || '';
    f.full_name.value = u.full_name || '';
    f.role.value = u.role || '';
    f.is_active.value = String(!!u.is_active);

    state.editingUserId = id;
    document.getElementById('userSubmitBtn').disabled = false;
    document.getElementById('userSubmitBtn').textContent = 'Simpan Perubahan';
    document.getElementById('userCancelBtn').style.display = 'inline-block';

    f.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    toast('Gagal memuat user: ' + (err.message || err), true);
  }
}

function cancelEditUser() {
  state.editingUserId = null;
  const f = document.getElementById('form-user');
  f.reset();
  document.getElementById('userSubmitBtn').disabled = true;
  document.getElementById('userSubmitBtn').textContent = 'Simpan Perubahan';
  document.getElementById('userCancelBtn').style.display = 'none';
  toast('Edit dibatalkan');
}

async function onSubmitUser(e) {
  e.preventDefault();
  if (!state.editingUserId) {
    toast('Pilih user yang akan diedit terlebih dahulu', true);
    return;
  }
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await updateProfile(state.editingUserId, {
      full_name: f.full_name.value.trim(),
      role: f.role.value,
      is_active: f.is_active.value === 'true'
    });
    toast('User berhasil diperbarui. Perubahan role berlaku setelah user login ulang.');
    state.editingUserId = null;
    f.reset();
    document.getElementById('userSubmitBtn').disabled = true;
    document.getElementById('userSubmitBtn').textContent = 'Simpan Perubahan';
    document.getElementById('userCancelBtn').style.display = 'none';
    await renderUsers();
  } catch (err) {
    toast('Gagal simpan user: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
  }
}