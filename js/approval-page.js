// js/approval-page.js
import { requireAuth, logout, getCurrentRole, getSetting } from './auth.js';
import { listPendingApprovals, approveSO, rejectSO, voidSO } from './approval.js';

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

(async () => {
  const user = await requireAuth();
  if (!user) return;

  currentRole = await getCurrentRole();
  if (!['finance','supervisor','admin','superadmin'].includes(currentRole)) {
    alert('Halaman ini hanya untuk supervisor/finance/admin.');
    window.location.href = './dashboard.html';
    return;
  }

  document.getElementById('logoutBtn').addEventListener('click', logout);

  currentMode = await getSetting('so_approval_mode') || 'supervisor_only';
  document.getElementById('approvalModeInfo').innerHTML =
    currentMode === 'supervisor_only'
      ? '<b>Mode:</b> Supervisor saja — cukup 1 supervisor approve.'
      : '<b>Mode:</b> Finance + Supervisor (paralel) — kedua role harus approve.';

  await renderList();
})();

async function renderList() {
  const wrap = document.getElementById('approvalList');
  wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Memuat...</div>';
  try {
    const list = await listPendingApprovals();
    const filtered = list.filter(so => {
      if (so.status === 'pending_approval') return true;
      if (so.status === 'approved') return true; // untuk tombol void
      return false;
    });

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

        // Tampilkan tombol approve kalau role sesuai dan belum approve
        let canApproveThis = false;
        if (currentRole === 'finance' && needFinance && !financeApproved) canApproveThis = true;
        if (['supervisor','admin','superadmin'].includes(currentRole) && !supervisorApproved) canApproveThis = true;

        if (canApproveThis) {
          buttons.push(`<button class="btn btn-primary" style="padding:6px 12px;font-size:12px;" data-approve="${so.id}">Approve</button>`);
        }
        buttons.push(`<button class="btn btn-danger" style="padding:6px 12px;font-size:12px;" data-reject="${so.id}">Reject</button>`);

        // Info status approval
        const info = [];
        if (needFinance) info.push(`Finance: ${financeApproved ? '✓' : '⏳'}`);
        info.push(`Supervisor: ${supervisorApproved ? '✓' : '⏳'}`);
        buttons.unshift(`<span style="font-size:12px;color:#6b7280;">${info.join(' · ')}</span>`);
      } else if (so.status === 'approved') {
        if (['supervisor','admin','superadmin'].includes(currentRole)) {
          buttons.push(`<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;background:#fef3c7;color:#92400e;" data-void="${so.id}">Void</button>`);
        }
      }

      return `
        <div class="journal-list-item">
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
          ${so.status === 'approved' ? '<div style="font-size:12px;color:#6b7280;margin-top:4px;">Menunggu gudang mark delivered (Fase 3).</div>' : ''}
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">${buttons.join('')}</div>
        </div>`;
    }).join('');

    wrap.querySelectorAll('[data-approve]').forEach(btn => {
      btn.addEventListener('click', () => onApprove(Number(btn.dataset.approve)));
    });
    wrap.querySelectorAll('[data-reject]').forEach(btn => {
      btn.addEventListener('click', () => onReject(Number(btn.dataset.reject)));
    });
    wrap.querySelectorAll('[data-void]').forEach(btn => {
      btn.addEventListener('click', () => onVoid(Number(btn.dataset.void)));
    });
  } catch (err) {
    wrap.innerHTML = `<div style="color:#b91c1c;font-size:13px;">${esc(err.message)}</div>`;
  }
}

async function onApprove(soId) {
  if (!confirm('Approve SO ini?')) return;
  try {
    const newStatus = await approveSO(soId);
    toast(`✓ Approved (status: ${newStatus})`);
    await renderList();
  } catch (err) {
    toast('Gagal approve: ' + (err.message || err), true);
  }
}

async function onReject(soId) {
  const reason = prompt('Alasan reject:');
  if (!reason) return;
  try {
    await rejectSO(soId, reason);
    toast('✓ SO ditolak');
    await renderList();
  } catch (err) {
    toast('Gagal reject: ' + (err.message || err), true);
  }
}

async function onVoid(soId) {
  const reason = prompt('Alasan void (barang belum keluar):');
  if (!reason) return;
  try {
    await voidSO(soId, reason);
    toast('✓ SO divoid');
    await renderList();
  } catch (err) {
    toast('Gagal void: ' + (err.message || err), true);
  }
}