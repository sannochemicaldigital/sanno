// js/settings-page.js
import { requireAuth, logout, hasRole, getCurrentRole } from './auth.js';
import { SETTING_DEFS, getAllSettings, updateSetting } from './settings.js';
import { supabase } from './supabase-client.js';

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => el.className = 'toast', 2600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

(async () => {
  const user = await requireAuth();
  if (!user) return;

  // Cek akses
  const isAdminUser = await hasRole('admin');
  if (!isAdminUser) {
    alert('Halaman ini hanya untuk admin/superadmin.');
    window.location.href = './dashboard.html';
    return;
  }

  document.getElementById('logoutBtn').addEventListener('click', logout);

  await renderSettings();
  await renderSalesPartners();

  document.getElementById('form-settings').addEventListener('submit', onSave);
  document.getElementById('addSalesPartnerBtn').addEventListener('click', onAddSalesPartner);
})();

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

async function onSave(e) {
  e.preventDefault();
  const btn = document.getElementById('saveBtn');
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
// SALES ↔ PARTNER
// ============================================================
async function renderSalesPartners() {
  const wrap = document.getElementById('salesPartnersList');
  wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Memuat...</div>';
  try {
    // Ambil semua user ber-role sales
    const { data: salesUsers, error: sErr } = await supabase
      .from('profiles')
      .select('id, email, full_name, role')
      .eq('role', 'sales');
    if (sErr) throw sErr;

    // Ambil semua customer
    const { data: customers, error: cErr } = await supabase
      .from('partners')
      .select('id, code, name')
      .eq('type', 'customer')
      .eq('is_active', true)
      .order('name');
    if (cErr) throw cErr;

    // Ambil relasi
    const { data: relations, error: rErr } = await supabase
      .from('sales_partners')
      .select('id, sales_id, partner_id');
    if (rErr) throw rErr;

    if (!salesUsers.length) {
      wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Belum ada user ber-role sales.</div>';
      return;
    }
    if (!customers.length) {
      wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Belum ada customer. Tambah di Master → Partner.</div>';
      return;
    }

    const salesMap = Object.fromEntries(salesUsers.map(u => [u.id, u]));
    const custMap  = Object.fromEntries(customers.map(c => [c.id, c]));

    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px;">';
    html += '<thead><tr style="background:#f9fafb;"><th style="padding:8px;text-align:left;">Sales</th><th style="padding:8px;text-align:left;">Pelanggan</th><th style="padding:8px;text-align:center;">Aksi</th></tr></thead><tbody>';
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

    // Form tambah relasi
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

    // Event hapus
    wrap.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Hapus relasi ini?')) return;
        const { error } = await supabase.from('sales_partners').delete().eq('id', Number(btn.dataset.del));
        if (error) { toast('Gagal hapus: ' + error.message, true); return; }
        toast('Relasi dihapus');
        await renderSalesPartners();
      });
    });

    // Event tambah
    document.getElementById('saveRelationBtn').addEventListener('click', async () => {
      const salesId = document.getElementById('newSalesId').value;
      const partnerId = document.getElementById('newPartnerId').value;
      if (!salesId || !partnerId) { toast('Pilih sales dan pelanggan', true); return; }
      const { error } = await supabase.from('sales_partners').insert({ sales_id: salesId, partner_id: Number(partnerId) });
      if (error) { toast('Gagal: ' + error.message, true); return; }
      toast('Relasi ditambahkan');
      await renderSalesPartners();
    });
  } catch (err) {
    wrap.innerHTML = `<div style="color:#b91c1c;font-size:13px;">${esc(err.message)}</div>`;
  }
}