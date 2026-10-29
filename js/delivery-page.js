// js/delivery-page.js
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission } from './permissions.js';
import { listDOs, markDelivered, cancelDO } from './delivery.js';

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

const state = {
  canDeliver: false,
  canCancel: false,
  canPrint: false
};

(async () => {
  const user = await requireAuth();
  if (!user) return;

  const role = await requirePageAccess('delivery');
  if (!role) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  await renderNav(document.getElementById('mainNav'), 'delivery');

  state.canDeliver = await hasPermission('delivery.mark_delivered');
  state.canCancel  = await hasPermission('delivery.cancel');
  state.canPrint   = await hasPermission('delivery.view');

  await renderList();
})();

async function renderList() {
  const wrap = document.getElementById('doList');
  wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Memuat...</div>';
  try {
    const list = await listDOs({ limit: 100 });
    if (!list.length) {
      wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Belum ada Delivery Order.</div>';
      return;
    }

    const statusBadge = s => {
      const colors = {
        issued:    '#fef3c7|#92400e',
        delivered: '#d1fae5|#065f46',
        cancelled: '#f3f4f6|#6b7280'
      };
      const [bg, fg] = (colors[s] || '#e5e7eb|#374151').split('|');
      return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase;">${esc(s)}</span>`;
    };

    wrap.innerHTML = list.map(d => {
      const so = d.sales_orders;
      const buttons = [];

      // Tombol Cetak — selalu muncul kalau punya permission delivery.view
      // (bisa cetak DO issued maupun delivered; cancelled tidak perlu)
      if (state.canPrint && d.status !== 'cancelled') {
        buttons.push(`<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;"
                              data-print="${d.id}">🖨 Cetak</button>`);
      }

      if (d.status === 'issued') {
        if (state.canDeliver) {
          buttons.push(`<button class="btn btn-primary" style="padding:6px 12px;font-size:12px;"
                                data-deliver="${d.id}">Mark Delivered</button>`);
        }
        if (state.canCancel) {
          buttons.push(`<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;background:#fef3c7;color:#92400e;"
                                data-cancel="${d.id}">Cancel DO</button>`);
        }
      }

      const actHtml = buttons.length
        ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${buttons.join('')}</div>`
        : '';

      return `
        <div class="journal-list-item">
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
            <div>
              <b>${esc(d.do_no)}</b> ${statusBadge(d.status)}<br>
              <span style="font-size:13px;">SO ${esc(so?.so_no || '')} · ${esc(so?.partners?.name || '')}</span>
            </div>
            <div style="text-align:right;font-size:13px;">
              <div>${fmt(so?.grand_total)}</div>
              <div style="color:#6b7280;font-size:12px;">${d.do_date}</div>
            </div>
          </div>
          ${actHtml}
        </div>`;
    }).join('');

    wrap.querySelectorAll('[data-print]').forEach(btn => {
      btn.addEventListener('click', () => onPrint(Number(btn.dataset.print)));
    });
    wrap.querySelectorAll('[data-deliver]').forEach(btn => {
      btn.addEventListener('click', () => onDeliver(Number(btn.dataset.deliver)));
    });
    wrap.querySelectorAll('[data-cancel]').forEach(btn => {
      btn.addEventListener('click', () => onCancel(Number(btn.dataset.cancel)));
    });
  } catch (err) {
    wrap.innerHTML = `<div style="color:#b91c1c;font-size:13px;">${esc(err.message)}</div>`;
  }
}

async function onPrint(doId) {
  if (!state.canPrint) { toast('Tidak ada akses cetak DO', true); return; }
  window.open(`./delivery-print.html?id=${doId}`, '_blank');
}

async function onDeliver(doId) {
  if (!state.canDeliver) { toast('Tidak ada akses mark delivered', true); return; }
  if (!confirm('Mark DO ini sebagai delivered?\n\nStok barang akan dikurangi dan jurnal penjualan akan otomatis terbuat.')) return;
  try {
    const journalId = await markDelivered(doId);
    toast(`✓ DO delivered, jurnal ID ${journalId} dibuat`);
    await renderList();
  } catch (err) {
    toast('Gagal: ' + (err.message || err), true);
  }
}

async function onCancel(doId) {
  if (!state.canCancel) { toast('Tidak ada akses cancel DO', true); return; }
  const reason = prompt('Alasan cancel DO:');
  if (!reason) return;
  try {
    await cancelDO(doId, reason);
    toast('✓ DO dibatalkan');
    await renderList();
  } catch (err) {
    toast('Gagal: ' + (err.message || err), true);
  }
}