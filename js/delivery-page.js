// js/delivery-page.js
// PATCH: countdown expires_at + tombol Re-issue (pakai RPC get_do_with_expiry + reissue_do)
import './input-clear.js';
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission } from './permissions.js';
import { markDelivered, cancelDO } from './delivery.js';
import { supabase } from './supabase-client.js';   // sesuaikan path bila perlu

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

// --- helper: format countdown detik -> "HH:MM:SS" ---
function fmtCountdown(sec) {
  if (sec == null || sec < 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// --- helper: format timestamp ke "YYYY-MM-DD HH:MM" lokal ---
function fmtTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// --- RPC: get_do_with_expiry ---
async function rpcListDOs({ status = null, onlyActive = false, search = null, limit = 100, offset = 0 } = {}) {
  const { data, error } = await supabase.rpc('get_do_with_expiry', {
    p_status: status,
    p_only_active: onlyActive,
    p_search: search,
    p_limit: limit,
    p_offset: offset
  });
  if (error) throw error;
  return data || [];
}

// --- RPC: reissue_do ---
async function rpcReissue(doId) {
  const { data, error } = await supabase.rpc('reissue_do', { p_do_id: doId });
  if (error) throw error;
  return data;
}

const state = {
  canDeliver: false,
  canCancel: false,
  canPrint: false,
  canReissue: false,
  filterStatus: '',        // '' = semua, atau 'issued','delivered','expired','cancelled'
  onlyActive: false,       // hanya DO issued yang belum expired
  search: '',
  list: [],                // cache list DO untuk tick countdown
  tickTimer: null
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
  // permission reissue: pakai delivery.mark_delivered kalau belum ada permission khusus
  state.canReissue = state.canDeliver;

  await bindFilters();
  await renderList();
})();

async function bindFilters() {
  const selStatus = document.getElementById('filterStatus');
  const chkActive = document.getElementById('filterOnlyActive');
  const inpSearch = document.getElementById('filterSearch');

  if (selStatus) {
    selStatus.addEventListener('change', async () => {
      state.filterStatus = selStatus.value;
      await renderList();
    });
  }
  if (chkActive) {
    chkActive.addEventListener('change', async () => {
      state.onlyActive = chkActive.checked;
      await renderList();
    });
  }
  if (inpSearch) {
    let t = null;
    inpSearch.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        state.search = inpSearch.value.trim();
        await renderList();
      }, 350);
    });
  }
}

function statusBadge(s) {
  const colors = {
    issued:    '#fef3c7|#92400e',
    delivered: '#d1fae5|#065f46',
    cancelled: '#f3f4f6|#6b7280',
    expired:   '#fee2e2|#991b1b'
  };
  const [bg, fg] = (colors[s] || '#e5e7eb|#374151').split('|');
  return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase;">${esc(s)}</span>`;
}

async function renderList() {
  const wrap = document.getElementById('doList');
  wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Memuat...</div>';
  try {
    const list = await rpcListDOs({
      status: state.filterStatus || null,
      onlyActive: state.onlyActive,
      search: state.search || null,
      limit: 100,
      offset: 0
    });
    state.list = list;

    if (!list.length) {
      wrap.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Belum ada Delivery Order.</div>';
      stopTick();
      return;
    }

    wrap.innerHTML = list.map(d => renderCard(d)).join('');
    bindCardActions(wrap);
    startTick();
  } catch (err) {
    wrap.innerHTML = `<div style="color:#b91c1c;font-size:13px;">${esc(err.message)}</div>`;
    stopTick();
  }
}

function renderCard(d) {
  // d = baris dari get_do_with_expiry
  const buttons = [];

  // Cetak DO
  if (state.canPrint && d.status !== 'cancelled') {
    buttons.push(`<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;"
                          data-print="${d.id}">🖨 Cetak DO</button>`);
  }

  // Invoice — hanya delivered
  if (state.canPrint && d.status === 'delivered' && d.so_id) {
    buttons.push(`<button class="btn btn-primary" style="padding:6px 12px;font-size:12px;"
                          data-invoice="${d.so_id}">🧾 Invoice</button>`);
  }

  // Issued aktif
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

  // Re-issue — hanya kalau can_reissue=true (issued atau expired)
  if (state.canReissue && d.can_reissue) {
    buttons.push(`<button class="btn btn-primary" style="padding:6px 12px;font-size:12px;background:#7c3aed;color:#fff;"
                          data-reissue="${d.id}">♻ Re-issue</button>`);
  }

  const actHtml = buttons.length
    ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${buttons.join('')}</div>`
    : '';

  // Info expiry — hanya untuk issued / expired
  let expiryHtml = '';
  if (d.status === 'issued' || d.status === 'expired') {
    if (d.status === 'expired' || d.is_expired) {
      expiryHtml = `<div style="margin-top:4px;font-size:12px;color:#991b1b;">
        ⛔ Expired pada ${fmtTs(d.expired_at || d.expires_at)}</div>`;
    } else if (d.expires_at) {
      expiryHtml = `<div style="margin-top:4px;font-size:12px;color:#92400e;">
        ⏳ Sisa waktu: <b data-countdown="${d.id}">${fmtCountdown(d.seconds_until_expiry) || '—'}</b>
        · expires ${fmtTs(d.expires_at)}</div>`;
    }
  }

  return `
    <div class="journal-list-item" data-do-card="${d.id}">
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <div>
          <b>${esc(d.do_no)}</b> ${statusBadge(d.status)}<br>
          <span style="font-size:13px;">SO ${esc(d.so_no || '')} · ${esc(d.partner_name || '')}</span>
        </div>
        <div style="text-align:right;font-size:13px;">
          <div style="color:#6b7280;font-size:12px;">${esc(d.do_date)}</div>
        </div>
      </div>
      ${expiryHtml}
      ${actHtml}
    </div>`;
}

function bindCardActions(wrap) {
  wrap.querySelectorAll('[data-print]').forEach(btn => {
    btn.addEventListener('click', () => onPrint(Number(btn.dataset.print)));
  });
  wrap.querySelectorAll('[data-invoice]').forEach(btn => {
    btn.addEventListener('click', () => onInvoice(Number(btn.dataset.invoice)));
  });
  wrap.querySelectorAll('[data-deliver]').forEach(btn => {
    btn.addEventListener('click', () => onDeliver(Number(btn.dataset.deliver)));
  });
  wrap.querySelectorAll('[data-cancel]').forEach(btn => {
    btn.addEventListener('click', () => onCancel(Number(btn.dataset.cancel)));
  });
  wrap.querySelectorAll('[data-reissue]').forEach(btn => {
    btn.addEventListener('click', () => onReissue(Number(btn.dataset.reissue)));
  });
}

// ---- live countdown tick ----
function startTick() {
  stopTick();
  state.tickTimer = setInterval(() => {
    if (!state.list.length) return;
    // decrement lokal per detik; kalau <=0, refresh list untuk sinkron dengan server
    let needsRefresh = false;
    state.list = state.list.map(d => {
      if (d.status === 'issued' && d.seconds_until_expiry != null) {
        const next = d.seconds_until_expiry - 1;
        if (next <= 0) needsRefresh = true;
        return { ...d, seconds_until_expiry: next };
      }
      return d;
    });

    state.list.forEach(d => {
      if (d.status !== 'issued') return;
      const el = document.querySelector(`[data-countdown="${d.id}"]`);
      if (el) {
        const txt = fmtCountdown(d.seconds_until_expiry);
        el.textContent = txt || '00:00:00';
      }
    });

    if (needsRefresh) {
      // ada DO yang habis countdown → refresh dari server (biar status 'expired' muncul)
      renderList();
    }
  }, 1000);
}
function stopTick() {
  if (state.tickTimer) {
    clearInterval(state.tickTimer);
    state.tickTimer = null;
  }
}

function onPrint(doId) {
  if (!state.canPrint) { toast('Tidak ada akses cetak DO', true); return; }
  window.open(`./delivery-print.html?id=${doId}`, '_blank');
}

function onInvoice(soId) {
  if (!state.canPrint) { toast('Tidak ada akses invoice', true); return; }
  window.open(`./invoice-print.html?id=${soId}`, '_blank');
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

async function onReissue(doId) {
  if (!state.canReissue) { toast('Tidak ada akses re-issue', true); return; }
  if (!confirm('Re-issue DO ini?\n\nStok akan di-reserve ulang dan masa berlaku diperpanjang +24 jam.')) return;
  try {
    const newId = await rpcReissue(doId);
    toast(`✓ DO di-reissue (id ${newId})`);
    await renderList();
  } catch (err) {
    toast('Gagal: ' + (err.message || err), true);
  }
}