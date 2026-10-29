// js/settings-page.js
import { requireAuth, logout, getCurrentRole } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { SETTING_DEFS, getAllSettings, updateSetting } from './settings.js';
import { listUsers, createUser, updateUser, deleteUser, AVAILABLE_ROLES } from './users.js';
import { initPermissionsTab } from './permissions-page.js';
import { listLockedPeriods, lockPeriod, unlockPeriod, checkPeriodLocked } from './periods.js';
import { supabase } from './supabase-client.js';

// ============================================================
// UTIL
// ============================================================
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

let currentRole = null;
let permissionsLoaded = false;
let periodsLoaded = false;

// ============================================================
// INIT
// ============================================================
(async () => {
  const user = await requireAuth();
  if (!user) return;

  currentRole = await requirePageAccess('settings');
  if (!currentRole) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  await renderNav(document.getElementById('mainNav'), 'settings');

  // Tab switching
  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      document.getElementById('tab-' + btn.dataset.tab).style.display = 'block';

      if (btn.dataset.tab === 'permissions' && !permissionsLoaded) {
        permissionsLoaded = true;
        try {
          await initPermissionsTab();
        } catch (err) {
          document.getElementById('rolePermissionsList').innerHTML =
            `<div style="color:#b91c1c;font-size:13px;">Gagal memuat: ${esc(err.message)}</div>`;
        }
      }

      if (btn.dataset.tab === 'periods' && !periodsLoaded) {
        periodsLoaded = true;
        await renderPeriods();
      }
    });
  });

  // Isi dropdown role untuk form user baru
  const roleSel = document.getElementById('newUserRole');
  roleSel.innerHTML = AVAILABLE_ROLES
    .filter(r => r.value !== 'superadmin' || currentRole === 'superadmin')
    .map(r => `<option value="${r.value}">${r.label}</option>`).join('');

  // Preview email dari username
  const usernameEl = document.querySelector('#form-new-user [name=username]');
  usernameEl.addEventListener('input', () => {
    const v = usernameEl.value.trim() || 'username';
    document.getElementById('emailPreview').textContent = `${v}@sanno.local`;
  });

  // Load tab yang butuh data di awal
  await Promise.all([
    renderSettings(),
    renderUsers(),
    renderSalesPartners()
  ]);

  // Event listeners form
  document.getElementById('form-settings').addEventListener('submit', onSaveSettings);
  document.getElementById('form-new-user').addEventListener('submit', onCreateUser);
  attachLockPeriodForm();
})();

// ============================================================
// TAB SISTEM
// ============================================================
async function renderSettings() {
  const form = document.getElementById('form-settings');
  const current = await getAllSettings();

  form.innerHTML = SETTING_DEFS.map(def => {
    const val = current[def.key]?.value ?? '';
    let input;
    if (def.type === 'select') {
      input = `<select name="${def.key}" style="width:100%;padding:10px;border:1px solid #d0d5dd;border-radius:8px;">
        ${def.options.map(o => `<option value="${o.value}" ${o.value === val ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>`;
    } else if (def.type === 'number') {
      input = `<input type="number" name="${def.key}" value="${esc(val)}" step="${def.step || '1'}"
                     style="width:100%;padding:10px;border:1px solid #d0d5dd;border-radius:8px;">`;
    } else {
      input = `<input type="text" name="${def.key}" value="${esc(val)}"
                     style="width:100%;padding:10px;border:1px solid #d0d5dd;border-radius:8px;">`;
    }
    return `
      <div class="form-row" style="margin-bottom:16px;">
        <label style="font-weight:600;">${esc(def.label)}</label>
        ${input}
        <div style="font-size:12px;color:#6b7280;margin-top:4px;">${esc(def.help)}</div>
      </div>`;
  }).join('');
}

async function onSaveSettings(e) {
  e.preventDefault();
  const btn = document.getElementById('saveSettingsBtn');
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  try {
    const form = e.target;
    for (const def of SETTING_DEFS) {
      const input = form.querySelector(`[name="${def.key}"]`);
      if (input) await updateSetting(def.key, input.value);
    }
    toast('✓ Pengaturan tersimpan');
  } catch (err) {
    toast('Gagal simpan: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan Pengaturan';
  }
}

// ============================================================
// TAB USER
// ============================================================
async function renderUsers() {
  const tbody = document.getElementById('tbody-users');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  try {
    const users = await listUsers();
    tbody.innerHTML = users.map(u => {
      const canEdit = currentRole === 'superadmin'
        || (currentRole === 'admin' && u.role !== 'superadmin');
      const canDelete = currentRole === 'superadmin' && u.role !== 'superadmin';
      return `
        <tr>
          <td data-label="Email">${esc(u.email)}</td>
          <td data-label="Nama">${esc(u.full_name || '—')}</td>
          <td data-label="Role">
            <select data-role-user="${u.id}" ${canEdit ? '' : 'disabled'}
                    style="padding:4px 8px;border:1px solid #d0d5dd;border-radius:6px;font-size:13px;">
              ${AVAILABLE_ROLES
                .filter(r => r.value !== 'superadmin' || currentRole === 'superadmin')
                .map(r => `<option value="${r.value}" ${r.value === u.role ? 'selected' : ''}>${r.label}</option>`)
                .join('')}
            </select>
          </td>
          <td data-label="Status">
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;">
              <input type="checkbox" data-active-user="${u.id}" ${u.is_active ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
              ${u.is_active ? 'Aktif' : 'Nonaktif'}
            </label>
          </td>
          <td data-label="Aksi">
            ${canEdit ? `<button class="btn btn-primary" style="padding:4px 10px;font-size:12px;"
                          data-save-user="${u.id}">Simpan</button>` : ''}
            ${canDelete ? `<button class="btn btn-danger" style="padding:4px 10px;font-size:12px;"
                          data-del-user="${u.id}" data-email="${esc(u.email)}">Hapus</button>` : ''}
          </td>
        </tr>`;
    }).join('') || '<tr><td colspan="5" style="text-align:center;color:#9ca3af;">Belum ada user</td></tr>';

    tbody.querySelectorAll('[data-save-user]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.saveUser;
        const role = tbody.querySelector(`[data-role-user="${uid}"]`).value;
        const isActive = tbody.querySelector(`[data-active-user="${uid}"]`).checked;
        const row = btn.closest('tr');
        const fullName = row.querySelector('[data-label="Nama"]').textContent.trim();
        try {
          await updateUser(uid, {
            full_name: fullName === '—' ? null : fullName,
            role, is_active: isActive
          });
          toast('✓ User diupdate');
          await renderUsers();
        } catch (err) {
          toast('Gagal: ' + (err.message || err), true);
        }
      });
    });

    tbody.querySelectorAll('[data-del-user]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Hapus permanen user ${btn.dataset.email}?`)) return;
        try {
          await deleteUser(btn.dataset.delUser);
          toast('✓ User dihapus');
          await renderUsers();
        } catch (err) {
          toast('Gagal: ' + (err.message || err), true);
        }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

async function onCreateUser(e) {
  e.preventDefault();
  const f = e.target;
  const btn = document.getElementById('createUserBtn');
  btn.disabled = true;
  btn.textContent = 'Membuat...';
  try {
    const username = f.username.value.trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
      throw new Error('Username hanya boleh huruf, angka, titik, underscore, strip');
    }
    await createUser({
      username,
      password: f.password.value,
      full_name: f.full_name.value.trim(),
      role: f.role.value
    });
    toast(`✓ User ${username} dibuat`);
    f.reset();
    document.getElementById('emailPreview').textContent = 'username@sanno.local';
    await renderUsers();
  } catch (err) {
    toast('Gagal buat user: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Buat User';
  }
}

// ============================================================
// TAB SALES ↔ PELANGGAN
// ============================================================
async function renderSalesPartners() {
  const wrap = document.getElementById('salesPartnersList');
  if (!wrap) return;
  wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Memuat...</div>';
  try {
    const { data: salesUsers, error: sErr } = await supabase
      .from('profiles').select('id, email, full_name, role').eq('role', 'sales');
    if (sErr) throw sErr;

    const { data: customers, error: cErr } = await supabase
      .from('partners').select('id, code, name')
      .eq('type', 'customer').eq('is_active', true).order('name');
    if (cErr) throw cErr;

    const { data: relations, error: rErr } = await supabase
      .from('sales_partners').select('id, sales_id, partner_id');
    if (rErr) throw rErr;

    if (!salesUsers.length) {
      wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Belum ada user ber-role sales. Tambah dulu di tab User.</div>';
      return;
    }
    if (!customers.length) {
      wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Belum ada customer. Tambah di Master → Partner.</div>';
      return;
    }

    const salesMap = Object.fromEntries(salesUsers.map(u => [u.id, u]));
    const custMap  = Object.fromEntries(customers.map(c => [c.id, c]));

    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
    html += '<thead><tr style="background:#f9fafb;">'
          + '<th style="padding:8px;text-align:left;">Sales</th>'
          + '<th style="padding:8px;text-align:left;">Pelanggan</th>'
          + '<th style="padding:8px;text-align:center;">Aksi</th>'
          + '</tr></thead><tbody>';
    html += relations.map(r => {
      const s = salesMap[r.sales_id];
      const c = custMap[r.partner_id];
      if (!s || !c) return '';
      return `
        <tr style="border-bottom:1px solid #eef0f3;">
          <td style="padding:8px;">${esc(s.full_name || s.email)}</td>
          <td style="padding:8px;">${esc(c.code || '')} — ${esc(c.name)}</td>
          <td style="padding:8px;text-align:center;">
            <button class="btn btn-danger" style="padding:4px 10px;font-size:12px;"
                    data-del="${r.id}">Hapus</button>
          </td>
        </tr>`;
    }).join('') || '<tr><td colspan="3" style="padding:16px;text-align:center;color:#9ca3af;">Belum ada relasi</td></tr>';
    html += '</tbody></table>';

    html += `
      <div style="margin-top:16px;padding:12px;background:#f9fafb;border-radius:8px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
          <select id="newSalesId" style="padding:8px;border:1px solid #d0d5dd;border-radius:6px;">
            <option value="">— pilih sales —</option>
            ${salesUsers.map(u => `<option value="${u.id}">${esc(u.full_name || u.email)}</option>`).join('')}
          </select>
          <select id="newPartnerId" style="padding:8px;border:1px solid #d0d5dd;border-radius:6px;">
            <option value="">— pilih pelanggan —</option>
            ${customers.map(c => `<option value="${c.id}">${esc(c.code || '')} — ${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-primary" style="padding:8px 14px;font-size:13px;" id="saveRelationBtn">Tambah Relasi</button>
      </div>`;

    wrap.innerHTML = html;

    wrap.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Hapus relasi ini?')) return;
        const { error } = await supabase.from('sales_partners').delete().eq('id', Number(btn.dataset.del));
        if (error) { toast('Gagal hapus: ' + error.message, true); return; }
        toast('Relasi dihapus');
        await renderSalesPartners();
      });
    });

    document.getElementById('saveRelationBtn').addEventListener('click', async () => {
      const salesId = document.getElementById('newSalesId').value;
      const partnerId = document.getElementById('newPartnerId').value;
      if (!salesId || !partnerId) { toast('Pilih sales dan pelanggan', true); return; }
      const { error } = await supabase.from('sales_partners').insert({
        sales_id: salesId, partner_id: Number(partnerId)
      });
      if (error) { toast('Gagal: ' + error.message, true); return; }
      toast('Relasi ditambahkan');
      await renderSalesPartners();
    });
  } catch (err) {
    wrap.innerHTML = `<div style="color:#b91c1c;font-size:13px;">${esc(err.message)}</div>`;
  }
}

// ============================================================
// TAB PERIODE
// ============================================================
async function renderPeriods() {
  const wrap = document.getElementById('lockedPeriodsList');
  if (!wrap) return;
  wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Memuat...</div>';

  try {
    const list = await listLockedPeriods();
    if (!list.length) {
      wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Belum ada periode terkunci.</div>';
      return;
    }

    const monthNames = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
    wrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:8px;text-align:left;">Periode</th>
            <th style="padding:8px;text-align:left;">Catatan</th>
            <th style="padding:8px;text-align:left;">Di-lock Oleh</th>
            <th style="padding:8px;text-align:left;">Tanggal</th>
            <th style="padding:8px;text-align:center;">Aksi</th>
          </tr>
        </thead>
        <tbody>
          ${list.map(p => `
            <tr style="border-bottom:1px solid #eef0f3;">
              <td style="padding:8px;font-weight:600;">${monthNames[p.month-1]} ${p.year}</td>
              <td style="padding:8px;">${esc(p.notes || '—')}</td>
              <td style="padding:8px;">${esc(p.profiles?.full_name || p.profiles?.email || '—')}</td>
              <td style="padding:8px;color:#6b7280;">${new Date(p.locked_at).toLocaleDateString('id-ID')}</td>
              <td style="padding:8px;text-align:center;">
                <button class="btn btn-danger" style="padding:4px 10px;font-size:12px;"
                        data-unlock="${p.id}" data-period="${monthNames[p.month-1]} ${p.year}">
                  🔓 Buka
                </button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    wrap.querySelectorAll('[data-unlock]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Buka kunci periode ${btn.dataset.period}?\n\nSetelah dibuka, jurnal di periode ini bisa diedit kembali.`)) return;
        try {
          await unlockPeriod(Number(btn.dataset.unlock));
          toast(`✓ Periode ${btn.dataset.period} dibuka`);
          await renderPeriods();
        } catch (err) {
          toast('Gagal: ' + (err.message || err), true);
        }
      });
    });
  } catch (err) {
    wrap.innerHTML = `<div style="color:#b91c1c;font-size:13px;">${esc(err.message)}</div>`;
  }
}

function attachLockPeriodForm() {
  const form = document.getElementById('form-lock-period');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = document.getElementById('lockPeriodBtn');
    btn.disabled = true;
    btn.textContent = 'Mengunci...';

    try {
      const year = Number(f.year.value);
      const month = Number(f.month.value);
      const notes = f.notes.value.trim() || null;

      const already = await checkPeriodLocked(year, month);
      if (already) {
        throw new Error(`Periode ${year}-${String(month).padStart(2,'0')} sudah terkunci`);
      }

      await lockPeriod(year, month, notes);
      toast(`✓ Periode ${year}-${String(month).padStart(2,'0')} dikunci`);
      f.notes.value = '';
      await renderPeriods();
    } catch (err) {
      toast('Gagal: ' + (err.message || err), true);
    } finally {
      btn.disabled = false;
      btn.textContent = '🔒 Kunci Periode';
    }
  });
}