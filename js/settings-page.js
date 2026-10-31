// js/settings-page.js
import './input-clear.js';
import { requireAuth, logout, getCurrentRole } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { SETTING_DEFS, getAllSettings, updateSetting } from './settings.js';
import { listUsers, createUser, updateUser, deleteUser, AVAILABLE_ROLES } from './users.js';
import { initPermissionsTab } from './permissions-page.js';
import { listLockedPeriods, lockPeriod, unlockPeriod, checkPeriodLocked } from './periods.js';
import { getCompanyProfile, updateCompanyProfile } from './company.js';
import {
  listBankAccounts, createBankAccount, updateBankAccount,
  deleteBankAccount, listBankCoaAccounts, getBankAccount
} from './bank-accounts.js';
import { hasPermission } from './permissions.js';
import { supabase } from './supabase-client.js';

// ============================================================
// AUDIT LOG
// ============================================================

// SESUDAH
let auditInitialized = false;   // [FIX] ganti auditLoaded — dipakai di tab switcher
let auditCanView = false;
let auditOffset = 0;
let auditReqSeq = 0;            // [FIX] race guard (opsional tapi direkomendasikan)
const AUDIT_LIMIT = 50;
const auditFilters = { action: '', entity: '', dateFrom: '', dateTo: '' };

async function initAuditTab() {
  auditCanView = await hasPermission('admin.audit.view');
  if (!auditCanView) {
    document.getElementById('tbody-audit').innerHTML =
      '<tr><td colspan="6" style="text-align:center;color:#b91c1c;">Tidak ada akses melihat audit log.</td></tr>';
    document.getElementById('auditMoreBtn').style.display = 'none';
    return;
  }

  // Load opsi filter (actions[], entities[])
  await loadAuditFilterOptions();

  // Bind filter
  document.getElementById('auditAction').addEventListener('change', (e) => {
    auditFilters.action = e.target.value;
    reloadAudit();
  });
  document.getElementById('auditEntity').addEventListener('change', (e) => {
    auditFilters.entity = e.target.value;
    reloadAudit();
  });
  document.getElementById('auditDateFrom').addEventListener('change', (e) => {
    auditFilters.dateFrom = e.target.value;
    reloadAudit();
  });
  document.getElementById('auditDateTo').addEventListener('change', (e) => {
    auditFilters.dateTo = e.target.value;
    reloadAudit();
  });
  document.getElementById('auditResetBtn').addEventListener('click', () => {
    auditFilters.action = '';
    auditFilters.entity = '';
    auditFilters.dateFrom = '';
    auditFilters.dateTo = '';
    document.getElementById('auditAction').value = '';
    document.getElementById('auditEntity').value = '';
    document.getElementById('auditDateFrom').value = '';
    document.getElementById('auditDateTo').value = '';
    reloadAudit();
  });
  document.getElementById('auditMoreBtn').addEventListener('click', () => loadAudit(true));

  // Load awal
  await reloadAudit();
}

async function loadAuditFilterOptions() {
  try {
    const { data, error } = await supabase.rpc('get_audit_filter_options');
    if (error) throw error;
    const actions = data?.actions || [];
    const entities = data?.entities || [];

    const selA = document.getElementById('auditAction');
    selA.innerHTML = '<option value="">Semua</option>' +
      actions.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');

    const selE = document.getElementById('auditEntity');
    selE.innerHTML = '<option value="">Semua</option>' +
      entities.map(e => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
  } catch (err) {
    console.error('loadAuditFilterOptions:', err);
  }
}

async function reloadAudit() {
  auditOffset = 0;
  document.getElementById('tbody-audit').innerHTML =
    '<tr><td colspan="6" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  document.getElementById('auditMoreBtn').style.display = 'none';
  document.getElementById('auditInfo').textContent = '';
  await loadAudit(false);
}

async function loadAudit(append = false) {
  const tbody = document.getElementById('tbody-audit');
  if (!append) tbody.innerHTML = '';
const seq = ++auditReqSeq;
  try {
    const { data, error } = await supabase.rpc('get_audit_logs', {
      p_user_id: null,
      p_action: auditFilters.action || null,
      p_entity: auditFilters.entity || null,
      p_date_from: auditFilters.dateFrom || null,
      p_date_to: auditFilters.dateTo || null,
      p_limit: AUDIT_LIMIT,
      p_offset: auditOffset
    });
    if (error) throw error;

    const rows = data || [];
    if (seq !== auditReqSeq) return;   // abaikan respons basi
    const totalCount = rows[0]?.total_count ?? rows.length;

    if (!append && !rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#9ca3af;">Tidak ada audit log cocok</td></tr>';
      document.getElementById('auditInfo').textContent = '';
      return;
    }

    const html = rows.map(r => renderAuditRow(r)).join('');
    if (append) tbody.insertAdjacentHTML('beforeend', html);
    else tbody.innerHTML = html;

    auditOffset += rows.length;
    document.getElementById('auditInfo').textContent =
      `Menampilkan ${Math.min(auditOffset, totalCount)} dari ${totalCount}`;

    document.getElementById('auditMoreBtn').style.display =
      auditOffset < totalCount ? 'inline-block' : 'none';
  } catch (err) {
    tbody.innerHTML += `<tr><td colspan="6" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

function renderAuditRow(r) {
  const ts = r.created_at ? new Date(r.created_at).toLocaleString('id-ID') : '—';
  const userName = r.user_name || r.user_email || r.user_id || '—';
  const entityId = r.entity_id != null ? r.entity_id : '—';
  const payloadStr = r.payload ? JSON.stringify(r.payload, null, 2) : '{}';
  const payloadId = 'payload-' + Math.random().toString(36).slice(2, 9);

  return `
    <tr>
      <td style="white-space:nowrap;font-size:12px;">${esc(ts)}</td>
      <td style="font-size:13px;">${esc(userName)}</td>
      <td><code style="font-size:12px;background:#eef2ff;padding:2px 6px;border-radius:4px;">${esc(r.action)}</code></td>
      <td style="font-size:13px;">${esc(r.entity)}</td>
      <td class="num">${esc(entityId)}</td>
      <td style="font-size:12px;">
        <button type="button" class="btn btn-secondary"
                style="padding:2px 8px;font-size:11px;"
                data-toggle-payload="${payloadId}">Lihat</button>
        <pre id="${payloadId}" style="display:none;margin:4px 0 0;padding:8px;background:#f9fafb;border-radius:4px;font-size:11px;max-width:400px;overflow:auto;">${esc(payloadStr)}</pre>
      </td>
    </tr>`;
}

// Toggle payload (delegated event)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-toggle-payload]');
  if (!btn) return;
  const id = btn.dataset.togglePayload;
  const el = document.getElementById(id);
  if (!el) return;
  const showing = el.style.display === 'block';
  el.style.display = showing ? 'none' : 'block';
  btn.textContent = showing ? 'Lihat' : 'Sembunyikan';
});

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

// ============================================================
// STATE
// ============================================================
let currentRole = null;
let permissionsLoaded = false;
let companyLoaded = false;
let bankLoaded = false;
let periodsLoaded = false;
let companyPerms = { view: false, manage: false };
let bankPerms = { view: false, manage: false };
let bankEditId = null;

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

      if (btn.dataset.tab === 'company' && !companyLoaded) {
        companyLoaded = true;
        await renderCompany();
      }

      if (btn.dataset.tab === 'bank' && !bankLoaded) {
        bankLoaded = true;
        await renderBank();
      }

      if (btn.dataset.tab === 'periods' && !periodsLoaded) {
        periodsLoaded = true;
        await renderPeriods();
      }
      if (btn.dataset.tab === 'audit' && !auditInitialized) {
  auditInitialized = true;
  try { await initAuditTab(); }
  catch (err) {
    document.getElementById('tbody-audit').innerHTML =
      `<tr><td colspan="6" style="color:#b91c1c;">Gagal: ${esc(err.message)}</td></tr>`;
  }
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
  document.getElementById('form-company').addEventListener('submit', onSaveCompany);
  document.getElementById('form-bank').addEventListener('submit', onSaveBank);
  document.getElementById('cancelBankEditBtn').addEventListener('click', resetBankForm);
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
// TAB PERUSAHAAN
// ============================================================
async function renderCompany() {
  const form = document.getElementById('form-company');
  if (!form) return;

  companyPerms.view   = await hasPermission('admin.company_profile.view');
  companyPerms.manage = await hasPermission('admin.company_profile.manage');

  if (!companyPerms.view) {
    form.closest('.card').innerHTML =
      '<div style="color:#b91c1c;font-size:13px;">Tidak ada akses melihat profil perusahaan.</div>';
    return;
  }

  try {
    const prof = await getCompanyProfile();
    form.name.value     = prof.name || '';
    form.address.value  = prof.address || '';
    form.phone.value    = prof.phone || '';
    form.email.value    = prof.email || '';
    form.website.value  = prof.website || '';
    form.tax_id.value   = prof.tax_id || '';
    form.logo_url.value = prof.logo_url || '';
    form.notes.value    = prof.notes || '';

    if (!companyPerms.manage) {
      form.querySelectorAll('input, textarea, button').forEach(el => el.disabled = true);
    }
  } catch (err) {
    toast('Gagal memuat profil: ' + err.message, true);
  }
}

async function onSaveCompany(e) {
  e.preventDefault();
  if (!companyPerms.manage) {
    toast('Tidak ada akses mengubah profil', true);
    return;
  }
  const f = e.target;
  const btn = document.getElementById('saveCompanyBtn');
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';

  try {
    await updateCompanyProfile({
      name:    f.name.value.trim(),
      address: f.address.value.trim(),
      phone:   f.phone.value.trim(),
      email:   f.email.value.trim(),
      website: f.website.value.trim(),
      tax_id:  f.tax_id.value.trim(),
      logo_url: f.logo_url.value.trim(),
      notes:   f.notes.value.trim()
    });
    toast('✓ Profil perusahaan tersimpan');
  } catch (err) {
    toast('Gagal: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan Profil Perusahaan';
  }
}

// ============================================================
// TAB BANK
// ============================================================
async function renderBank() {
  const form = document.getElementById('form-bank');
  const wrap = document.getElementById('bankList');
  if (!form || !wrap) return;

  bankPerms.view   = await hasPermission('admin.bank_accounts.view');
  bankPerms.manage = await hasPermission('admin.bank_accounts.manage');

  if (!bankPerms.view) {
    wrap.innerHTML = '<div style="color:#b91c1c;font-size:13px;">Tidak ada akses melihat rekening bank.</div>';
    form.style.display = 'none';
    return;
  }

  // Isi dropdown akun COA
  const coa = await listBankCoaAccounts();
  const sel = document.getElementById('bankCoaSelect');
  sel.innerHTML = '<option value="">— pilih akun —</option>' +
    coa.map(a => `<option value="${a.id}">${esc(a.code)} — ${esc(a.name)}</option>`).join('');

  if (!bankPerms.manage) {
    form.querySelectorAll('input, select, button').forEach(el => el.disabled = true);
  }

  await renderBankList();
}

async function renderBankList() {
  const wrap = document.getElementById('bankList');
  if (!wrap) return;
  wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Memuat...</div>';

  try {
    const list = await listBankAccounts();
    if (!list.length) {
      wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Belum ada rekening bank. Tambah lewat form di atas.</div>';
      return;
    }

    wrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:8px;text-align:left;">Bank</th>
            <th style="padding:8px;text-align:left;">No. Rekening</th>
            <th style="padding:8px;text-align:left;">Atas Nama</th>
            <th style="padding:8px;text-align:left;">Cabang</th>
            <th style="padding:8px;text-align:left;">Akun COA</th>
            <th style="padding:8px;text-align:center;">Status</th>
            <th style="padding:8px;text-align:center;">Aksi</th>
          </tr>
        </thead>
        <tbody>
          ${list.map(b => `
            <tr style="border-bottom:1px solid #eef0f3;">
              <td style="padding:8px;font-weight:600;">${esc(b.bank_name)}</td>
              <td style="padding:8px;font-family:monospace;">${esc(b.account_no)}</td>
              <td style="padding:8px;">${esc(b.account_name)}</td>
              <td style="padding:8px;color:#6b7280;">${esc(b.branch || '—')}</td>
              <td style="padding:8px;font-size:12px;color:#6b7280;">
                ${esc(b.accounts?.code || '—')} ${esc(b.accounts?.name || '')}
              </td>
              <td style="padding:8px;text-align:center;">
                ${b.is_active
                  ? '<span style="color:#059669;font-weight:600;">Aktif</span>'
                  : '<span style="color:#9ca3af;">Nonaktif</span>'}
              </td>
              <td style="padding:8px;text-align:center;">
                ${bankPerms.manage ? `
                  <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;"
                          data-edit-bank="${b.id}">Edit</button>
                  <button class="btn btn-danger" style="padding:4px 10px;font-size:12px;"
                          data-del-bank="${b.id}" data-label="${esc(b.bank_name)} ${esc(b.account_no)}">Hapus</button>
                ` : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    wrap.querySelectorAll('[data-edit-bank]').forEach(btn => {
      btn.addEventListener('click', () => onEditBank(Number(btn.dataset.editBank)));
    });

    wrap.querySelectorAll('[data-del-bank]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Hapus rekening ${btn.dataset.label}?`)) return;
        try {
          await deleteBankAccount(Number(btn.dataset.delBank));
          toast('✓ Rekening dihapus');
          await renderBankList();
        } catch (err) {
          toast('Gagal: ' + (err.message || err), true);
        }
      });
    });
  } catch (err) {
    wrap.innerHTML = `<div style="color:#b91c1c;font-size:13px;">${esc(err.message)}</div>`;
  }
}

async function onSaveBank(e) {
  e.preventDefault();
  if (!bankPerms.manage) { toast('Tidak ada akses mengubah rekening', true); return; }
  const f = e.target;
  const btn = document.getElementById('saveBankBtn');
  btn.disabled = true;
  btn.textContent = bankEditId ? 'Mengupdate...' : 'Menyimpan...';

  try {
    const payload = {
      account_id: Number(f.account_id.value),
      bank_name: f.bank_name.value.trim(),
      account_no: f.account_no.value.trim(),
      account_name: f.account_name.value.trim(),
      branch: f.branch.value.trim() || null,
      sort_order: Number(f.sort_order.value) || 0,
      is_active: f.is_active.value === 'true'
    };

    if (!payload.account_id) throw new Error('Pilih akun COA');
    if (!payload.bank_name)  throw new Error('Nama bank wajib diisi');
    if (!payload.account_no) throw new Error('Nomor rekening wajib diisi');
    if (!payload.account_name) throw new Error('Atas nama wajib diisi');

    if (bankEditId) {
      await updateBankAccount(bankEditId, payload);
      toast('✓ Rekening diupdate');
    } else {
      await createBankAccount(payload);
      toast('✓ Rekening ditambahkan');
    }

    resetBankForm();
    await renderBankList();
  } catch (err) {
    toast('Gagal: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan Rekening';
  }
}

async function onEditBank(id) {
  try {
    const b = await getBankAccount(id);
    bankEditId = id;

    const f = document.getElementById('form-bank');
    f.account_id.value   = b.account_id || '';
    f.bank_name.value    = b.bank_name || '';
    f.account_no.value   = b.account_no || '';
    f.account_name.value = b.account_name || '';
    f.branch.value       = b.branch || '';
    f.sort_order.value   = b.sort_order || 0;
    f.is_active.value    = b.is_active ? 'true' : 'false';

    document.getElementById('saveBankBtn').textContent = 'Update Rekening';
    document.getElementById('cancelBankEditBtn').style.display = 'inline-block';
    f.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    toast('Gagal muat: ' + err.message, true);
  }
}

function resetBankForm() {
  document.getElementById('form-bank').reset();
  bankEditId = null;
  document.getElementById('saveBankBtn').textContent = 'Simpan Rekening';
  document.getElementById('cancelBankEditBtn').style.display = 'none';
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