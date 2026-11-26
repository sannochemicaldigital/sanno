// js/permissions-page.js
import {
  listPermissions, listRolePermissions, setRolePermission,
  listUserPermissions, setUserPermission
} from './permissions.js';
import { listUsers } from './users.js';
import { getCurrentRole } from './auth.js';

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

const ROLES = ['viewer','sales','kasir','gudang','finance','supervisor','admin','superadmin'];

// ============================================================
// KUNCI "ADMIN ONLY" — samakan dengan fungsi public.is_admin_only_permission()
// di SQL/SQL-v11.28-akses-admin-only.sql.
// Kunci ini TIDAK boleh di-ON-kan untuk role selain admin/superadmin.
// Kalau daftar di SQL berubah, ubah juga daftar ini.
// ============================================================
const ADMIN_ROLES = ['admin', 'superadmin'];
const ADMIN_ONLY_PERMS = new Set([
  // A. dokumen & jurnal
  'sales.order.edit', 'sales.order.cancel', 'sales.order.void',
  'sales.order.display_name_custom', 'delivery.cancel', 'delivery.edit_display_name',
  'kasir.void', 'finance.journal.edit', 'finance.journal.delete',
  'finance.journal.reversal', 'finance.hutang.payment.delete',
  'historical.payment.delete',
  // B. koreksi stok & opname
  'inventory.stock_adjust', 'inventory.stock_adjust.post',
  'inventory.stock_adjust.backdate_unlimited',
  'inventory.opname.create', 'inventory.opname.approve',
  'finance.cash_opname.create', 'finance.cash_opname.execute',
  // C. master, harga, admin
  'inventory.item.edit', 'inventory.item.delete', 'inventory.price_list.manage',
  'master.accounts.manage', 'master.partners.manage', 'master.items.manage',
  'master.currencies.manage',
  'admin.users.edit', 'admin.users.delete', 'admin.settings.manage',
  'admin.permissions.manage', 'admin.period.lock', 'admin.period.unlock',
  'admin.backup', 'admin.company_profile.manage', 'admin.bank_accounts.manage'
]);
const isLockedForRole = (role, key) =>
  ADMIN_ONLY_PERMS.has(key) && !ADMIN_ROLES.includes(role);

let permissions = [];
let rolePermMap = {};   // { 'role|perm': true }
let currentUserPerms = {};
let userRoleById = {};  // { 'uuid': 'finance' }

export async function initPermissionsTab() {
  const role = await getCurrentRole();
  if (!['admin','superadmin'].includes(role)) return;

  permissions = await listPermissions();
  const rp = await listRolePermissions();
  rolePermMap = {};
  rp.forEach(r => { rolePermMap[`${r.role}|${r.permission}`] = true; });

  renderRoleTable();
  await renderUserOverride();
}

// ============================================================
// TABEL ROLE × PERMISSION
// ============================================================
function renderRoleTable() {
  const wrap = document.getElementById('rolePermissionsList');
  const byCategory = {};
  permissions.forEach(p => {
    byCategory[p.category] = byCategory[p.category] || [];
    byCategory[p.category].push(p);
  });

  let html = '';
  for (const [cat, perms] of Object.entries(byCategory)) {
    html += `
      <div style="margin-bottom:16px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#f9fafb;padding:10px 12px;font-weight:600;font-size:13px;">${esc(cat)}</div>
        <div class="table-wrap">
          <table style="min-width:800px;">
            <thead>
              <tr>
                <th style="position:sticky;left:0;background:#fff;z-index:2;">Permission</th>
                ${ROLES.map(r => `<th style="text-align:center;font-size:11px;">${r}</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${perms.map(p => {
                const adminOnly = ADMIN_ONLY_PERMS.has(p.key);
                return `
                <tr>
                  <td style="position:sticky;left:0;background:#fff;z-index:1;">
                    <div style="font-size:13px;">
                      ${esc(p.label)}
                      ${adminOnly
                        ? `<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;">ADMIN+</span>`
                        : ''}
                    </div>
                    <div style="font-size:11px;color:#9ca3af;"><code>${esc(p.key)}</code></div>
                  </td>
                  ${ROLES.map(r => {
                    const locked = isLockedForRole(r, p.key);
                    return `
                    <td style="text-align:center;">
                      <input type="checkbox" data-role="${r}" data-perm="${p.key}"
                        ${rolePermMap[`${r}|${p.key}`] ? 'checked' : ''}
                        ${r === 'superadmin' ? 'disabled' : ''}
                        ${locked ? 'disabled' : ''}
                        title="${locked
                          ? 'Khusus admin & superadmin (aturan SQL-v11.28)'
                          : (r === 'superadmin' ? 'Superadmin selalu punya semua izin' : '')}">
                    </td>`;
                  }).join('')}
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }
  wrap.innerHTML = html;

  wrap.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const role = cb.dataset.role;
      const perm = cb.dataset.perm;
      const granted = cb.checked;
      try {
        await setRolePermission(role, perm, granted);
        toast(`✓ ${role} / ${perm} → ${granted ? 'ON' : 'OFF'}`);
      } catch (err) {
        toast('Gagal: ' + err.message, true);
        cb.checked = !granted; // revert
      }
    });
  });
}

// ============================================================
// OVERRIDE PER USER
// ============================================================
async function renderUserOverride() {
  const users = await listUsers();
  userRoleById = {};
  users.forEach(u => { userRoleById[u.id] = u.role; });

  const sel = document.getElementById('overrideUserSelect');
  sel.innerHTML = '<option value="">— pilih user —</option>' +
    users.map(u => `<option value="${u.id}">${esc(u.full_name || u.email)} (${u.role})</option>`).join('');

  sel.onchange = async () => {
    if (!sel.value) {
      document.getElementById('userPermissionsList').innerHTML = '';
      return;
    }
    await loadUserPerms(sel.value, userRoleById[sel.value] || null);
  };
}

async function loadUserPerms(userId, userRole = null) {
  currentUserPerms = {};
  const rows = await listUserPermissions(userId);
  rows.forEach(r => { currentUserPerms[r.permission] = r.granted; });

  const wrap = document.getElementById('userPermissionsList');
  const byCategory = {};
  permissions.forEach(p => {
    byCategory[p.category] = byCategory[p.category] || [];
    byCategory[p.category].push(p);
  });

  let html = '';
  for (const [cat, perms] of Object.entries(byCategory)) {
    html += `
      <details style="margin-bottom:12px;border:1px solid #e5e7eb;border-radius:8px;padding:8px;">
        <summary style="cursor:pointer;font-weight:600;font-size:13px;">${esc(cat)}</summary>
        <div style="margin-top:8px;">
          ${perms.map(p => {
            const override = currentUserPerms[p.key];
            const state = override === undefined ? 'default' : (override ? 'on' : 'off');
            const locked = isLockedForRole(userRole || '', p.key);
            const badge = ADMIN_ONLY_PERMS.has(p.key)
              ? `<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;">ADMIN+</span>`
              : '';
            const control = locked
              ? `<span title="Khusus admin & superadmin (aturan SQL-v11.28)"
                       style="font-size:11px;color:#92400e;background:#fef3c7;padding:3px 8px;border-radius:6px;">terkunci</span>`
              : `<select data-userid="${userId}" data-perm="${p.key}"
                        style="padding:4px 8px;border:1px solid #d0d5dd;border-radius:6px;font-size:12px;">
                  <option value="default" ${state === 'default' ? 'selected' : ''}>Default (ikut role)</option>
                  <option value="on"      ${state === 'on'      ? 'selected' : ''}>Izinkan</option>
                  <option value="off"     ${state === 'off'     ? 'selected' : ''}>Cabut</option>
                </select>`;
            return `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6;">
                <div>
                  <div style="font-size:13px;">${esc(p.label)} ${badge}</div>
                  <div style="font-size:11px;color:#9ca3af;"><code>${esc(p.key)}</code></div>
                </div>
                ${control}
              </div>`;
          }).join('')}
        </div>
      </details>`;
  }
  wrap.innerHTML = html;

  wrap.querySelectorAll('select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const uid = sel.dataset.userid;
      const perm = sel.dataset.perm;
      const v = sel.value;
      try {
        if (v === 'default') {
          await setUserPermission(uid, perm, null);
          toast(`✓ ${perm} kembali ke default role`);
        } else {
          await setUserPermission(uid, perm, v === 'on');
          toast(`✓ ${perm} → ${v === 'on' ? 'IZINKAN' : 'CABUT'}`);
        }
      } catch (err) {
        toast('Gagal: ' + err.message, true);
      }
    });
  });
}