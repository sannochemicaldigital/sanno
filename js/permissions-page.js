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

let permissions = [];
let rolePermMap = {};   // { 'role|perm': true }
let currentUserPerms = {};

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
              ${perms.map(p => `
                <tr>
                  <td style="position:sticky;left:0;background:#fff;z-index:1;">
                    <div style="font-size:13px;">${esc(p.label)}</div>
                    <div style="font-size:11px;color:#9ca3af;"><code>${esc(p.key)}</code></div>
                  </td>
                  ${ROLES.map(r => `
                    <td style="text-align:center;">
                      <input type="checkbox" data-role="${r}" data-perm="${p.key}"
                        ${rolePermMap[`${r}|${p.key}`] ? 'checked' : ''}
                        ${r === 'superadmin' ? 'disabled' : ''}>
                    </td>`).join('')}
                </tr>`).join('')}
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
  const sel = document.getElementById('overrideUserSelect');
  sel.innerHTML = '<option value="">— pilih user —</option>' +
    users.map(u => `<option value="${u.id}">${esc(u.full_name || u.email)} (${u.role})</option>`).join('');

  sel.onchange = async () => {
    if (!sel.value) {
      document.getElementById('userPermissionsList').innerHTML = '';
      return;
    }
    await loadUserPerms(sel.value);
  };
}

async function loadUserPerms(userId) {
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
            return `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f3f4f6;">
                <div>
                  <div style="font-size:13px;">${esc(p.label)}</div>
                  <div style="font-size:11px;color:#9ca3af;"><code>${esc(p.key)}</code></div>
                </div>
                <select data-userid="${userId}" data-perm="${p.key}"
                        style="padding:4px 8px;border:1px solid #d0d5dd;border-radius:6px;font-size:12px;">
                  <option value="default" ${state === 'default' ? 'selected' : ''}>Default (ikut role)</option>
                  <option value="on"      ${state === 'on'      ? 'selected' : ''}>Izinkan</option>
                  <option value="off"     ${state === 'off'     ? 'selected' : ''}>Cabut</option>
                </select>
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