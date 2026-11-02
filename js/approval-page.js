// js/approval-page.js
import { requireAuth, logout, getCurrentRole, getSetting } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission } from './permissions.js';
import { listPendingApprovals, approveSO, rejectSO, voidSO, getSOLines } from './approval.js';

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

let currentRole = null;
let currentMode = 'supervisor_only';
let perms = { approve: false, reject: false, void: false };

// Cache lines per SO: { soId: { loading, lines, error } }
const linesCache = {};

(async () => {
  const user = await requireAuth();
  if (!user) return;

  currentRole = await requirePageAccess('approval');
  if (!currentRole) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  await renderNav(document.getElementById('mainNav'), 'approval');

  perms.approve = await hasPermission('sales.order.approve');
  perms.reject  = await hasPermission('sales.order.reject');
  perms.void    = await hasPermission('sales.order.void');

  currentMode = await getSetting('so_approval_mode') || 'supervisor_only';
  document.getElementById('approvalModeInfo').innerHTML =
    currentMode === 'supervisor_only'
      ? '<b>Mode:</b> Supervisor saja — cukup 1 supervisor approve.'
      : '<b>Mode:</b> Finance + Supervisor (paralel) — kedua role harus approve.';

  await renderList();
})();

// ============================================================
// RENDER LIST
// ============================================================
async function renderList() {
  const wrap = document.getElementById('approvalList');
  wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Memuat...</div>';
  try {
    const list = await listPendingApprovals();
    const filtered = list.filter(so =>
      so.status === 'pending_approval' || so.status === 'approved'
    );

    if (!filtered.length) {
      wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Tidak ada SO yang perlu diproses.</div>';
      return;
    }

    const statusBadge = s => {
      const colors = {
        pending_approval: '#fef3c7|#92400e',
        approved:         '#dbeafe|#1e40af'
      };
      const [bg, fg] = (colors[s] || '#e5e7eb|#374151').split('|');
      return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase;">${esc(s)}</span>`;
    };

    wrap.innerHTML = filtered.map(so => {
      const buttons = [];
      if (so.status === 'pending_approval') {
        const financeApproved = so.approved_finance_at != null;
        const supervisorApproved = so.approved_supervisor_at != null;
        const needFinance = currentMode === 'finance_and_supervisor';

        let canApproveThis = false;
        if (perms.approve) {
          if (currentRole === 'finance' && needFinance && !financeApproved) canApproveThis = true;
          if (currentRole !== 'finance' && !supervisorApproved) canApproveThis = true;
        }

        if (canApproveThis) {
          buttons.push(`<button class="btn btn-primary" style="padding:6px 12px;font-size:12px;" data-approve="${so.id}">Approve</button>`);
        }
        if (perms.reject) {
          buttons.push(`<button class="btn btn-danger" style="padding:6px 12px;font-size:12px;" data-reject="${so.id}">Reject</button>`);
        }

        const info = [];
        if (needFinance) info.push(`Finance: ${financeApproved ? '✓' : '⏳'}`);
        info.push(`Supervisor: ${supervisorApproved ? '✓' : '⏳'}`);
        buttons.unshift(`<span style="font-size:12px;color:#6b7280;">${info.join(' · ')}</span>`);
      } else if (so.status === 'approved') {
        if (perms.void) {
          buttons.push(`<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;background:#fef3c7;color:#92400e;" data-void="${so.id}">Void</button>`);
        }
      }

      return `
        <div class="journal-list-item" data-so-id="${so.id}">
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <div>
              <b>${esc(so.so_no)}</b> ${statusBadge(so.status)}<br>
              <span style="font-size:13px;">${esc(so.partners?.name || '')} · ${esc(so.profiles?.full_name || so.profiles?.email || '')}</span>
            </div>
            <div style="text-align:right;font-size:13px;">
              <div>${fmt(so.grand_total)}</div>
              <div style="color:#6b7280;font-size:12px;">${so.so_date}</div>
            </div>
          </div>
          ${so.status === 'approved' ? '<div style="font-size:12px;color:#6b7280;margin-top:4px;">Menunggu gudang mark delivered.</div>' : ''}
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
            <button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;" data-detail="${so.id}">📋 Lihat detail</button>
            ${buttons.join('')}
          </div>
          <div class="so-detail-panel" data-so-detail="${so.id}" style="display:none;margin-top:10px;"></div>
        </div>`;
    }).join('');

    // Bind tombol
    wrap.querySelectorAll('[data-approve]').forEach(btn => {
      btn.addEventListener('click', () => onApprove(Number(btn.dataset.approve)));
    });
    wrap.querySelectorAll('[data-reject]').forEach(btn => {
      btn.addEventListener('click', () => onReject(Number(btn.dataset.reject)));
    });
    wrap.querySelectorAll('[data-void]').forEach(btn => {
      btn.addEventListener('click', () => onVoid(Number(btn.dataset.void)));
    });
    wrap.querySelectorAll('[data-detail]').forEach(btn => {
      btn.addEventListener('click', () => toggleDetail(Number(btn.dataset.detail), btn));
    });
  } catch (err) {
    wrap.innerHTML = `<div style="color:#b91c1c;font-size:13px;">${esc(err.message)}</div>`;
  }
}

// ============================================================
// TOGGLE DETAIL — lihat lines + selisih harga
// ============================================================
async function toggleDetail(soId, btn) {
  const panel = document.querySelector(`[data-so-detail="${soId}"]`);
  if (!panel) return;

  // Kalau sudah terbuka → tutup
  if (panel.style.display !== 'none') {
    panel.style.display = 'none';
    btn.textContent = '📋 Lihat detail';
    return;
  }

  // Buka
  panel.style.display = 'block';
  btn.textContent = '▼ Tutup detail';

  // Kalau sudah ada cache → render dari cache
  if (linesCache[soId]?.lines) {
    renderDetailPanel(panel, linesCache[soId].lines);
    return;
  }

  panel.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:6px 0;">Memuat detail...</div>';

  try {
    const lines = await getSOLines(soId);
    linesCache[soId] = { lines };
    renderDetailPanel(panel, lines);
  } catch (err) {
    panel.innerHTML = `<div style="color:#b91c1c;font-size:12px;">Gagal load detail: ${esc(err.message)}</div>`;
  }
}

function renderDetailPanel(panel, lines) {
  if (!lines.length) {
    panel.innerHTML = '<div style="color:#9ca3af;font-size:12px;">Tidak ada line.</div>';
    return;
  }

  const pendingCount = lines.filter(l =>
    l.price_override_status === 'pending' && l.price_diff != null && Math.abs(Number(l.price_diff)) > 0.01
  ).length;

  const warningBanner = pendingCount > 0
    ? `<div style="background:#fef3c7;color:#92400e;padding:8px 10px;border-radius:6px;margin-bottom:8px;font-size:12px;font-weight:600;">
        ⚠ ${pendingCount} line harganya berbeda dari price list. Periksa sebelum approve.
      </div>`
    : `<div style="background:#d1fae5;color:#065f46;padding:8px 10px;border-radius:6px;margin-bottom:8px;font-size:12px;font-weight:600;">
        ✓ Semua harga sesuai price list.
      </div>`;

  const rows = lines.map(l => {
    const plPrice = l.price_list_price != null ? fmt(l.price_list_price) : '—';
    const plEff   = l.price_list_effective_price != null ? fmt(l.price_list_effective_price) : '—';
    const soEff   = l.so_effective_price != null ? fmt(l.so_effective_price) : fmt(l.unit_price);
    const diff    = Number(l.price_diff || 0);
    const diffPct = Number(l.price_diff_pct || 0);
    const hasDiff = l.price_diff != null && Math.abs(diff) > 0.01;

    let diffHtml = '<span style="color:#9ca3af;">—</span>';
    if (hasDiff) {
      const color = diff < 0 ? '#b91c1c' : '#059669';
      const sign = diff > 0 ? '+' : '';
      diffHtml = `<span style="color:${color};font-weight:600;white-space:nowrap;">
        ${sign}${fmt(diff)} (${sign}${diffPct.toFixed(2)}%)
      </span>`;
    }

    let statusBadge = '';
    switch (l.price_override_status) {
      case 'ok':       statusBadge = '<span style="background:#d1fae5;color:#065f46;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;">Sesuai</span>'; break;
      case 'pending':  statusBadge = '<span style="background:#fef3c7;color:#92400e;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;">Pending</span>'; break;
      case 'approved': statusBadge = '<span style="background:#dbeafe;color:#1e40af;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;">Approved</span>'; break;
      case 'rejected': statusBadge = '<span style="background:#fee2e2;color:#991b1b;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;">Rejected</span>'; break;
      default:         statusBadge = '—';
    }

    return `
      <tr>
        <td style="padding:6px 4px;font-size:12px;white-space:nowrap;">
          <b>${esc(l.items?.sku || '')}</b>
        </td>
        <td style="padding:6px 4px;font-size:12px;">${esc(l.items?.name || '')}</td>
        <td style="padding:6px 4px;font-size:12px;text-align:right;">${Number(l.qty).toLocaleString('id-ID')}</td>
        <td style="padding:6px 4px;font-size:12px;text-align:right;font-family:'Courier New',monospace;">${plPrice}</td>
        <td style="padding:6px 4px;font-size:12px;text-align:right;font-family:'Courier New',monospace;">${soEff}</td>
        <td style="padding:6px 4px;font-size:12px;text-align:right;">${diffHtml}</td>
        <td style="padding:6px 4px;text-align:center;">${statusBadge}</td>
        <td style="padding:6px 4px;font-size:11px;color:#6b7280;max-width:180px;word-break:break-word;">
          ${l.price_override_reason ? esc(l.price_override_reason) : '<span style="color:#9ca3af;">—</span>'}
        </td>
      </tr>`;
  }).join('');

  panel.innerHTML = `
    ${warningBanner}
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;">
        <thead>
          <tr style="background:#f3f4f6;">
            <th style="padding:6px 4px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">SKU</th>
            <th style="padding:6px 4px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">Nama</th>
            <th style="padding:6px 4px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">Qty</th>
            <th style="padding:6px 4px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">Harga PL</th>
            <th style="padding:6px 4px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">Harga Diajukan</th>
            <th style="padding:6px 4px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">Selisih</th>
            <th style="padding:6px 4px;text-align:center;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">Status</th>
            <th style="padding:6px 4px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;">Alasan Sales</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ============================================================
// APPROVE / REJECT / VOID
// ============================================================
async function onApprove(soId) {
  if (!perms.approve) { toast('Tidak ada akses approve', true); return; }
  if (!confirm('Approve SO ini?')) return;
  try {
    const newStatus = await approveSO(soId);
    if (newStatus === 'approved') {
      toast('✓ Approved — DO otomatis terbit, menunggu gudang mark delivered');
    } else {
      toast(`✓ Approved sebagian (status: ${newStatus})`);
    }
    // Invalidate cache & reload
    delete linesCache[soId];
    await renderList();
  } catch (err) {
    toast('Gagal approve: ' + (err.message || err), true);
  }
}

async function onReject(soId) {
  if (!perms.reject) { toast('Tidak ada akses reject', true); return; }
  const reason = prompt('Alasan reject:');
  if (!reason) return;
  try {
    await rejectSO(soId, reason);
    toast('✓ SO ditolak');
    delete linesCache[soId];
    await renderList();
  } catch (err) {
    toast('Gagal reject: ' + (err.message || err), true);
  }
}

async function onVoid(soId) {
  if (!perms.void) { toast('Tidak ada akses void', true); return; }
  const reason = prompt('Alasan void (barang belum keluar):');
  if (!reason) return;
  try {
    await voidSO(soId, reason);
    toast('✓ SO divoid');
    delete linesCache[soId];
    await renderList();
  } catch (err) {
    toast('Gagal void: ' + (err.message || err), true);
  }
}