// js/inventory-page.js
import './input-clear.js';
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission } from './permissions.js';
import { listItems, createItem } from './items.js';
import { supabase } from './supabase-client.js';
import { listUnits, createUnit, updateUnit, deleteUnit, reactivateUnit } from './units.js';

// Penanda build — dipakai untuk memastikan browser sudah memuat versi terbaru
// (naikkan angka ini + query string di inventory.html setiap kali file diubah).
const BUILD = 'v11.24.5';
document.body.dataset.build = BUILD;
console.log('[inventory-page] build', BUILD);

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
function fmt(n) {
  return Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function fmtDateTime(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('id-ID'); } catch { return esc(ts); }
}
function statusBadge(status) {
  const map = {
    draft:     { bg:'#e5e7eb', fg:'#374151', label:'Draft' },
    submitted: { bg:'#fef3c7', fg:'#92400e', label:'Submitted' },
    executed:  { bg:'#d1fae5', fg:'#065f46', label:'Executed' },
    cancelled: { bg:'#fee2e2', fg:'#991b1b', label:'Cancelled' }
  };
  const s = map[status] || { bg:'#e5e7eb', fg:'#374151', label: status || '—' };
  return `<span style="background:${s.bg};color:${s.fg};padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px;">${esc(s.label)}</span>`;
}
function reasonLabel(r) {
  return ({ rusak:'Rusak', hilang:'Hilang', salah_input:'Salah input', lainnya:'Lainnya' })[r] || (r || '—');
}

let allItems = [];
let inventoryRows = [];
let allUnits = [];
// State kartu stok (dideklarasikan di atas agar aman dari TDZ saat init)
const cardState = { item: null, rows: [], journalMap: {}, truncated: false, unitMode: 'base' };

const perms = {
  create: false, stockIn: false, viewPrice: false, viewMovement: false,
  stockAdjust: false, stockAdjustPost: false,
  opnameView: false, opnameCreate: false, opnameApprove: false,
  priceListView: false, priceListManage: false
};
const invFilter = {
  search: '',
  onlyReserved: false,
  onlyLowStock: false
};
function renderJournalBadge(r) {
  if (!r.needs_journal) {
    return '<span style="color:#9ca3af;" title="Tidak perlu jurnal (nilai selisih Rp 0)">—</span>';
  }
  if (r.journal_entry_id != null) {
    const tgl = r.journal_posted_at ? new Date(r.journal_posted_at).toLocaleDateString('id-ID') : '';
    const badge = `<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px;">Sudah${tgl ? ' · ' + esc(tgl) : ''}</span>`;
    const batal = perms.stockAdjustPost
      ? ` <button type="button" class="btn btn-secondary" data-unpost-journal="${r.journal_entry_id}"
                 style="padding:2px 8px;font-size:11px;"
                 title="Batalkan posting jurnal ini (stok tidak berubah)">Batal</button>`
      : '';
    return badge + batal;
  }
  const nilai = Math.abs(Number(r.qty_delta || 0)) * Number(r.avg_cost_snapshot || 0);
  const tombol = perms.stockAdjustPost
    ? ` <button type="button" class="btn btn-secondary" data-post-adjust="${r.adjustment_id}"
               style="padding:2px 8px;font-size:11px;"
               title="Posting jurnal · nilai selisih Rp ${fmt(nilai)}">Posting</button>`
    : '';
  return `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px;">Belum dijurnal</span>${tombol}`;
}

// ---------- state tab koreksi stok ----------
let stockAdjustInitialized = false;
let allItemsForAdjust = [];
const adjustFilter = { search: '', from: '', to: '', onlyUnjournaled: false };
const ADJUST_LIMIT = 50;
let adjustOffset = 0;
let adjustReqSeq = 0;
let adjustRowsCache = [];
let adjustTotalCount = 0;

// ---------- state tab opname massal ----------
let opnameInitialized = false;
let currentOpnameId = null;
let opnameLinesCache = [];
let currentOpnameStatus = '';
// get_opname() mengembalikan SEMUA line (jsonb) sekaligus, jadi line opname
// tidak dipecah per halaman.
const opnameFilter = { search: '', onlyDelta: false };
let opnameLineReqSeq = 0;
const opnameHistFilter = { search: '', status: '', from: '', to: '' };
const OPNAME_HIST_LIMIT = 50;
let opnameHistOffset = 0;
let opnameHistReqSeq = 0;

// ---------- state tab price list ----------
let priceListInitialized = false;
let priceListRowsCache = [];
const priceListFilter = { search: '', onlyWithPrice: false };
const PRICE_LIST_LIMIT = 200;
let priceListOffset = 0;
let priceListTotalCount = 0;
let priceListReqSeq = 0;
let priceListDirty = new Set();
const priceListHistFilter = { search: '', itemId: null };
const PRICE_LIST_HIST_LIMIT = 100;
let priceListHistOffset = 0;
let priceListHistTotalCount = 0;
let priceListHistReqSeq = 0;

(async () => {
  const user = await requireAuth();
  if (!user) return;

  const role = await requirePageAccess('inventory');
  if (!role) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  await renderNav(document.getElementById('mainNav'), 'inventory');

  perms.create       = await hasPermission('inventory.item.create');
  perms.stockIn      = await hasPermission('inventory.stock_in');
  perms.viewPrice    = await hasPermission('inventory.item.view_price');
  perms.viewMovement = await hasPermission('inventory.movement.view');
  perms.stockAdjust  = await hasPermission('inventory.stock_adjust');
  perms.stockAdjustPost = await hasPermission('inventory.stock_adjust.post');
  perms.opnameView   = await hasPermission('inventory.opname.view');
  perms.opnameCreate = await hasPermission('inventory.opname.create');
  perms.opnameApprove= await hasPermission('inventory.opname.approve');
  perms.priceListView   = await hasPermission('inventory.price_list.view');
  perms.priceListManage = await hasPermission('inventory.price_list.manage');

  if (!perms.create)  document.getElementById('form-new-item').style.display = 'none';
  if (!perms.stockIn) document.getElementById('form-stock-in').style.display = 'none';
  if (!perms.viewMovement) {
    const histCard = document.getElementById('tbody-movements')?.closest('.card');
    if (histCard) histCard.style.display = 'none';
  }

  if (!perms.priceListView) {
    const plTabBtn = document.querySelector('.tabs button[data-tab="pricelist"]');
    if (plTabBtn) plTabBtn.style.display = 'none';
  }

  const stockInDate = document.querySelector('#form-stock-in [name=movement_date]');
  if (stockInDate) stockInDate.value = todayISO();

  if (perms.create)  document.getElementById('form-new-item').addEventListener('submit', onCreateItem);
  if (perms.stockIn) document.getElementById('form-stock-in').addEventListener('submit', onStockIn);

  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      const panel = document.getElementById('tab-' + btn.dataset.tab);
      if (panel) panel.style.display = 'block';

      if (btn.dataset.tab === 'adjust' && !stockAdjustInitialized) {
        stockAdjustInitialized = true;
        try { await initStockAdjustTab(); }
        catch (err) {
          document.getElementById('tbody-stock-adjust').innerHTML =
            `<tr><td colspan="10" style="color:#b91c1c;">Gagal memuat: ${esc(err.message)}</td></tr>`;
        }
      }

      if (btn.dataset.tab === 'opname' && !opnameInitialized) {
        opnameInitialized = true;
        try { await initOpnameTab(); }
        catch (err) {
          const el = document.getElementById('tbody-opname-lines');
          if (el) el.innerHTML = `<tr><td colspan="8" style="color:#b91c1c;">Gagal memuat: ${esc(err.message)}</td></tr>`;
        }
      }

      if (btn.dataset.tab === 'pricelist' && !priceListInitialized) {
        priceListInitialized = true;
        try { await initPriceListTab(); }
        catch (err) {
          const el = document.getElementById('tbody-price-list');
          if (el) el.innerHTML = `<tr><td colspan="9" style="color:#b91c1c;">Gagal memuat: ${esc(err.message)}</td></tr>`;
        }
      }
    });
  });

  bindInventoryFilters();
  await loadUnitsAndFillDropdown();
  wireUnitsModal();
  wireItemCard();
  await loadAll();
})();

// ---------- filter binding ----------
function bindInventoryFilters() {
  const inpSearch = document.getElementById('invSearch');
  const chkReserved = document.getElementById('invOnlyReserved');
  const chkLow = document.getElementById('invOnlyLowStock');

  if (inpSearch) {
    let t = null;
    inpSearch.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        invFilter.search = inpSearch.value.trim();
        await renderInventory();
      }, 300);
    });
  }
  if (chkReserved) {
    chkReserved.addEventListener('change', async () => {
      invFilter.onlyReserved = chkReserved.checked;
      await renderInventory();
    });
  }
  if (chkLow) {
    chkLow.addEventListener('change', () => {
      invFilter.onlyLowStock = chkLow.checked;
      renderInventoryTable();
    });
  }
}

async function loadAll() {
  const tasks = [renderInventory(), loadItemsForDropdown()];
  if (perms.viewMovement) tasks.push(renderMovements());
  await Promise.all(tasks);
}

// ---------- RPC inventory ----------
async function rpcInventory() {
  const { data, error } = await supabase.rpc('get_inventory_with_reservation', {
    p_search: invFilter.search || null,
    p_only_reserved: invFilter.onlyReserved,
    p_limit: 500,
    p_offset: 0
  });
  if (error) throw error;
  return data || [];
}

async function renderInventory() {
  const tbody = document.getElementById('tbody-inventory');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  try {
    inventoryRows = await rpcInventory();
    renderInventoryTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

// ============================================================
// RENDER TABEL STOK — tampilan DRUM + info kg/ltr
// ============================================================
function renderInventoryTable() {
  const tbody = document.getElementById('tbody-inventory');
  if (!tbody) return;

  let rows = inventoryRows;
  if (invFilter.onlyLowStock) rows = rows.filter(r => r.is_low_stock);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Tidak ada item cocok</td></tr>';
    return;
  }

  // Helper: format drum + info kg/ltr
  function fmtDrum(r) {
    const stock = Number(r.stock_qty);
    const isiKg  = Number(r.packaging_isi_kg)  || 0;
    const isiLtr = Number(r.packaging_isi_ltr) || 0;
    const unit = (r.unit || '').toLowerCase();
    const isi = unit === 'ltr' ? isiLtr : isiKg;
    const unitLabel = unit === 'ltr' ? 'ltr' : 'kg';

    if (!isi || isi <= 0) {
      return {
        drum: '—',
        kg: `${fmt(stock)} ${unitLabel}`,
        drumNum: null
      };
    }

    const drum = stock / isi;
    const drumStr = Number.isInteger(drum)
      ? drum.toLocaleString('id-ID')
      : drum.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    return {
      drum: drumStr,
      kg: `${fmt(stock)} ${unitLabel}`,
      drumNum: drum
    };
  }

  tbody.innerHTML = rows.map(i => {
    const stock = Number(i.stock_qty);
    const reserved = Number(i.reserved_qty);
    const available = Number(i.available_qty);
    const min = Number(i.min_stock);

    let statusHtml;
    if (stock === 0) statusHtml = '<span style="color:#b91c1c;font-weight:600;">KOSONG</span>';
    else if (i.is_low_stock) statusHtml = '<span style="color:#b45309;font-weight:600;">RENDAH</span>';
    else statusHtml = '<span style="color:#059669;">OK</span>';

    const stockFmt = fmtDrum(i);
    const reservedFmt = fmtDrum({ ...i, stock_qty: reserved });
    const availFmt = fmtDrum({ ...i, stock_qty: available });

    const packagingLabel = i.packaging_nama || 'Drum';
    const packagingLower = packagingLabel.toLowerCase();
    const isiLabel = i.unit === 'ltr'
      ? (i.packaging_isi_ltr ? `${i.packaging_isi_ltr} ltr` : '')
      : (i.packaging_isi_kg ? `${i.packaging_isi_kg} kg` : '');

    const stockColor = stock < 0 ? '#b91c1c' : (stock === 0 ? '#6b7280' : '#1a1a1a');

    return `
      <tr class="row-clickable" data-sku="${esc(i.sku)}" tabindex="0" title="Klik untuk membuka kartu stok & histori mutasi">
        <td data-label="SKU">${esc(i.sku)} <span style="color:#9ca3af;font-size:11px;">›</span></td>
        <td data-label="Nama">
          <div>${esc(i.name)}</div>
          ${isiLabel ? `<div style="font-size:11px;color:#9ca3af;">${esc(packagingLabel)} · ${esc(isiLabel)}</div>` : ''}
        </td>
        <td data-label="Stok (Drum)" class="num">
          <div style="font-weight:700;font-size:15px;color:${stockColor};">
            ${stockFmt.drum}
            <span style="font-size:11px;font-weight:400;color:#6b7280;">${esc(packagingLower)}</span>
          </div>
          <div style="font-size:11px;color:#9ca3af;">(${stockFmt.kg})</div>
        </td>
        <td data-label="Reserved" class="num">
          ${reserved > 0
            ? `<div style="font-weight:600;">${reservedFmt.drum} <span style="font-size:10px;color:#6b7280;">${esc(packagingLower)}</span></div>
               <div style="font-size:10px;color:#9ca3af;">(${reservedFmt.kg})</div>`
            : `<span style="color:#9ca3af;">0</span>`}
        </td>
        <td data-label="Available" class="num">
          <div style="font-weight:600;${i.is_low_stock ? 'color:#b45309;' : ''}">${availFmt.drum} <span style="font-size:10px;color:#6b7280;">${esc(packagingLower)}</span></div>
          <div style="font-size:10px;color:#9ca3af;">(${availFmt.kg})</div>
        </td>
        <td data-label="Min" class="num">${fmt(min)}</td>
        <td data-label="Status">${statusHtml}</td>
      </tr>`;
  }).join('');
}

// ============================================================
// KARTU STOK PER ITEM — dibuka dengan klik baris di Daftar Stok
// Menampilkan: ringkasan stok + seluruh riwayat mutasi + saldo berjalan
// (state `cardState` dideklarasikan di bagian atas file)
// ============================================================

// Tanggal DB (YYYY-MM-DD) -> tampilan dd/mm/yyyy
function fmtDate(iso) {
  if (!iso) return '—';
  const s = String(iso);
  return /^\d{4}-\d{2}-\d{2}/.test(s)
    ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`
    : esc(s);
}

// qty di stock_movements selalu positif; arah ditentukan oleh type.
// Untuk type 'adjust', arah diambil dari stock_adjustments.qty_delta.
function signedMovementQty(m, adjMap) {
  const q = Math.abs(Number(m.qty) || 0);
  if (m.type === 'out') return -q;
  if (m.type === 'adjust') {
    const d = adjMap[m.id];
    if (d != null && Number(d) !== 0) return Number(d);
    return q;
  }
  return q;
}

function cardChip(label, valueHtml, color) {
  return `
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;min-width:104px;">
      <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.4px;">${esc(label)}</div>
      <div style="font-size:15px;font-weight:700;color:${color || '#1a1a1a'};">${valueHtml}</div>
    </div>`;
}

// ---------- satuan kartu stok: dasar (kg/ltr) <-> drum ----------
function cardUnitInfo() {
  const item = cardState.item || {};
  const rawUnit = String(item.unit || '').toLowerCase();
  const isLtr = rawUnit === 'ltr';
  // Satuan dasar: ikuti kolom items.unit (kg/ltr/pcs/...), default kg
  const baseLabel = rawUnit || 'kg';
  const isi = Number(isLtr ? item.packaging_isi_ltr : item.packaging_isi_kg) || 0;
  const drumLabel = String(item.packaging_nama || 'drum').toLowerCase();
  return { isLtr, baseLabel, isi, drumLabel };
}

// true bila mode drum aktif DAN item punya isi kemasan
function cardIsDrum() {
  const { isi } = cardUnitInfo();
  return cardState.unitMode === 'drum' && isi > 0;
}

// Angka qty (absolut) sesuai mode satuan
function cardFmtQty(value) {
  const { isi } = cardUnitInfo();
  const n = Math.abs(Number(value) || 0);
  if (cardIsDrum()) {
    return (n / isi).toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  }
  return fmt(n);
}

// Nilai string + satuan, mis. "1.000 kg" / "5 drum"
function cardQtyWithUnit(value) {
  const { baseLabel, drumLabel } = cardUnitInfo();
  return `${cardFmtQty(value)} ${cardIsDrum() ? drumLabel : baseLabel}`;
}

// Satuan "lain" (untuk baris kecil di bawah angka)
function cardAltQtyWithUnit(value) {
  const { baseLabel, drumLabel, isi } = cardUnitInfo();
  const n = Math.abs(Number(value) || 0);
  if (!(isi > 0)) return '';
  if (cardIsDrum()) return `${fmt(n)} ${baseLabel}`;
  return `${(n / isi).toLocaleString('id-ID', { maximumFractionDigits: 2 })} ${drumLabel}`;
}

// Label satuan untuk header kolom
function cardQtyUnitLabel() {
  const { baseLabel, drumLabel } = cardUnitInfo();
  return cardIsDrum() ? drumLabel : baseLabel;
}

// Sinkronkan tombol toggle + judul kolom tabel
function paintCardUnitUi() {
  const { baseLabel, drumLabel, isi } = cardUnitInfo();
  const items = [['cardUnitBase', baseLabel], ['cardUnitDrum', drumLabel]];
  items.forEach(([id, label]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent = label;
    const aktif = (id === 'cardUnitDrum') === cardIsDrum();
    btn.classList.toggle('active', aktif);
    if (id === 'cardUnitDrum') {
      btn.disabled = !(isi > 0);
      btn.title = isi > 0
        ? `1 ${drumLabel} = ${fmt(isi)} ${baseLabel}`
        : `Isi kemasan item belum diisi (packaging_isi_kg / packaging_isi_ltr)`;
    }
  });

  const unit = cardQtyUnitLabel();
  const map = {
    'th-card-in': `Masuk (${unit})`,
    'th-card-out': `Keluar (${unit})`,
    'th-card-saldo': `Saldo (${unit})`,
    'th-card-price': `Harga / ${baseLabel}`
  };
  Object.entries(map).forEach(([id, text]) => {
    const th = document.getElementById(id);
    if (th) th.textContent = text;
  });
}

function setCardUnitMode(mode) {
  if (mode === 'drum') {
    const { isi } = cardUnitInfo();
    if (!(isi > 0)) { toast('Item ini belum punya isi kemasan (drum)', true); return; }
  }
  cardState.unitMode = mode === 'drum' ? 'drum' : 'base';
  try { localStorage.setItem('sanno.cardUnitMode', cardState.unitMode); } catch { /* ignorir */ }
  paintCardUnitUi();
  renderItemCard();
}

function closeItemCard() {
  const modal = document.getElementById('itemCardModal');
  if (modal) modal.style.display = 'none';
  cardState.item = null;
  cardState.rows = [];
  cardState.journalMap = {};
  cardState.truncated = false;
}

async function openItemCard(sku) {
  const modal = document.getElementById('itemCardModal');
  if (!modal || !sku) return;

  const tbody   = document.getElementById('tbody-item-card');
  const titleEl = document.getElementById('cardItemTitle');
  const subEl   = document.getElementById('cardItemSub');
  const sumEl   = document.getElementById('cardSummary');
  const infoEl  = document.getElementById('cardInfo');

  modal.style.display = 'flex';
  if (titleEl) titleEl.textContent = sku;
  if (subEl) subEl.textContent = '';
  if (sumEl) sumEl.innerHTML = '';
  if (infoEl) infoEl.textContent = 'Memuat mutasi...';
  if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  const fromEl = document.getElementById('cardDateFrom');
  const toEl   = document.getElementById('cardDateTo');
  if (fromEl) fromEl.value = '';
  if (toEl) toEl.value = '';

  try {
    const { data: item, error: e1 } = await supabase
      .from('items')
      .select('id, sku, name, unit, stock_qty, min_stock, avg_cost, is_active, packaging_nama, packaging_isi_kg, packaging_isi_ltr')
      .eq('sku', sku)
      .single();
    if (e1) throw e1;

    if (!perms.viewMovement) {
      cardState.item = item;
      cardState.rows = [];
      cardState.journalMap = {};
      renderItemCardHeader();
      if (infoEl) infoEl.textContent = '';
      if (tbody) tbody.innerHTML =
        '<tr><td colspan="9" style="text-align:center;color:#b45309;">Riwayat mutasi memerlukan akses inventory.movement.view</td></tr>';
      return;
    }

    const { data: movs, error: e2 } = await supabase
      .from('stock_movements')
      .select('id, movement_date, type, qty, unit_cost, total_cost, memo, ref_journal_id')
      .eq('item_id', item.id)
      .order('movement_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(1000);
    if (e2) throw e2;

    // Arah koreksi stok (movement -> stock_adjustments.qty_delta)
    let adjMap = {};
    const { data: adjs, error: e3 } = await supabase
      .from('stock_adjustments')
      .select('movement_id, qty_delta')
      .eq('item_id', item.id);
    if (e3) {
      console.warn('[kartu stok] gagal memuat stock_adjustments:', e3.message);
    } else {
      (adjs || []).forEach(a => {
        if (a.movement_id != null) adjMap[a.movement_id] = Number(a.qty_delta);
      });
    }

    // Nomor jurnal untuk kolom "Jurnal" (dipecah agar URL tidak kepanjangan)
    let journalMap = {};
    const jids = [...new Set((movs || []).map(m => m.ref_journal_id).filter(Boolean))];
    for (let i = 0; i < jids.length; i += 100) {
      const chunk = jids.slice(i, i + 100);
      const { data: jrn, error: e4 } = await supabase
        .from('journals')
        .select('id, journal_no')
        .in('id', chunk);
      if (e4) { console.warn('[kartu stok] gagal memuat nomor jurnal:', e4.message); break; }
      (jrn || []).forEach(j => { journalMap[j.id] = j.journal_no; });
    }

    cardState.item = item;
    cardState.rows = (movs || []).map(m => ({ ...m, signed: signedMovementQty(m, adjMap) }));
    cardState.journalMap = journalMap;
    cardState.truncated = (movs || []).length >= 1000;

    renderItemCardHeader();
    renderItemCard();
  } catch (err) {
    console.error('openItemCard:', err);
    if (infoEl) infoEl.textContent = '';
    if (tbody) tbody.innerHTML =
      `<tr><td colspan="9" style="color:#b91c1c;">Gagal memuat kartu stok: ${esc(err.message || err)}</td></tr>`;
  }
}

// Ringkasan di kepala kartu stok
function renderItemCardHeader() {
  const item = cardState.item;
  if (!item) return;

  const inv = inventoryRows.find(r => r.sku === item.sku) || null;
  const stock = Number(item.stock_qty) || 0;
  const reserved = inv ? Number(inv.reserved_qty) || 0 : null;
  const available = inv ? Number(inv.available_qty) || 0 : null;
  const { isi, baseLabel, drumLabel } = cardUnitInfo();

  const subEl = document.getElementById('cardItemSub');
  if (subEl) {
    const bits = [item.name || '', item.unit ? `satuan ${item.unit}` : ''];
    if (!item.is_active) bits.push('NONAKTIF');
    if (item.packaging_nama) {
      bits.push(`${item.packaging_nama}${isi > 0 ? ' · ' + fmt(isi) + ' ' + baseLabel : ''}`);
    }
    subEl.textContent = bits.filter(Boolean).join(' · ');
  }

  // Chip: satuan aktif jadi angka utama, satuan lain jadi baris kecil
  const chipValue = (qty, color) => {
    const primary = cardQtyWithUnit(qty);
    const alt = cardAltQtyWithUnit(qty);
    return {
      html: `${esc(primary)}${alt ? `<div style="font-size:11px;font-weight:400;color:#6b7280;">${esc(alt)}</div>` : ''}`,
      color
    };
  };

  const stockColor = stock < 0 ? '#b91c1c' : (stock === 0 ? '#6b7280' : '#059669');
  const stokChip = chipValue(stock, stockColor);
  const chips = [cardChip('Stok', stokChip.html, stokChip.color)];
  if (reserved != null) {
    const c = chipValue(reserved);
    chips.push(cardChip('Reserved', c.html, c.color));
  }
  if (available != null) {
    const c = chipValue(available, available <= 0 ? '#b91c1c' : undefined);
    chips.push(cardChip('Available', c.html, c.color));
  }
  const minChip = chipValue(item.min_stock);
  chips.push(cardChip('Min Stok', minChip.html, minChip.color));
  if (perms.viewPrice) chips.push(cardChip('HPP Rata-rata', fmt(item.avg_cost)));
  chips.push(cardChip('Jumlah Mutasi', fmt(cardState.rows.length)));

  const sumEl = document.getElementById('cardSummary');
  if (sumEl) sumEl.innerHTML = chips.join('');

  // Tombol satuan + judul kolom qty
  if (!(isi > 0) && cardState.unitMode === 'drum') cardState.unitMode = 'base';
  paintCardUnitUi();
}

// Isi tabel kartu stok (kronologis + saldo berjalan)
function renderItemCard() {
  const tbody = document.getElementById('tbody-item-card');
  const infoEl = document.getElementById('cardInfo');
  const item = cardState.item;
  if (!tbody || !item) return;

  const fromEl = document.getElementById('cardDateFrom');
  const toEl   = document.getElementById('cardDateTo');
  const from = fromEl ? fromEl.value : '';
  const to   = toEl ? toEl.value : '';

  // Urut kronologis naik
  const all = [...cardState.rows].sort((a, b) => {
    const d = String(a.movement_date).localeCompare(String(b.movement_date));
    return d !== 0 ? d : (Number(a.id) - Number(b.id));
  });

  // Saldo akhir = items.stock_qty, jadi saldo sebelum mutasi bisa diturunkan
  const totalSigned = all.reduce((s, m) => s + m.signed, 0);
  const saldoAwal = (Number(item.stock_qty) || 0) - totalSigned;
  let running = saldoAwal;
  const withSaldo = all.map(m => { running += m.signed; return { ...m, saldo_after: running }; });

  const rows = withSaldo.filter(m =>
    (!from || String(m.movement_date) >= from) && (!to || String(m.movement_date) <= to));

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#9ca3af;">${
      all.length ? 'Tidak ada mutasi pada rentang tanggal ini' : 'Belum ada mutasi stok untuk item ini'}</td></tr>`;
  } else {
    const unitLabel = cardQtyUnitLabel();
    tbody.innerHTML = rows.map(m => {
      const typeLabel = m.type === 'in' ? 'Masuk'
                      : m.type === 'out' ? 'Keluar'
                      : m.type === 'adjust' ? (m.signed < 0 ? 'Koreksi −' : 'Koreksi +')
                      : m.type;
      const typeColor = m.type === 'in' ? '#059669'
                      : m.type === 'out' ? '#b91c1c'
                      : (m.signed < 0 ? '#b91c1c' : '#0891b2');
      const jNo = m.ref_journal_id ? (cardState.journalMap[m.ref_journal_id] || '—') : '—';
      const altSaldo = cardAltQtyWithUnit(m.saldo_after);
      return `
        <tr>
          <td data-label="Tanggal" style="white-space:nowrap;">${fmtDate(m.movement_date)}</td>
          <td data-label="Tipe"><span style="color:${typeColor};font-weight:600;">${esc(typeLabel)}</span></td>
          <td data-label="Masuk (${esc(unitLabel)})" class="num">${m.signed > 0 ? cardFmtQty(m.signed) : ''}</td>
          <td data-label="Keluar (${esc(unitLabel)})" class="num">${m.signed < 0 ? cardFmtQty(m.signed) : ''}</td>
          <td data-label="Saldo (${esc(unitLabel)})" class="num${Number(m.saldo_after) < 0 ? ' neg' : ''}">${cardFmtQty(m.saldo_after)}${
            altSaldo ? `<div style="font-size:10px;font-weight:400;color:#9ca3af;white-space:nowrap;">${esc(altSaldo)}</div>` : ''}</td>
          <td data-label="Harga" class="num">${perms.viewPrice ? fmt(m.unit_cost) : '—'}</td>
          <td data-label="Total" class="num">${perms.viewPrice ? fmt(m.total_cost) : '—'}</td>
          <td data-label="Jurnal" style="white-space:nowrap;font-size:12px;">${esc(jNo)}</td>
          <td data-label="Memo" style="font-size:12px;">${esc(m.memo || '—')}</td>
        </tr>`;
    }).join('');
  }

  if (infoEl) {
    const { baseLabel, drumLabel, isi } = cardUnitInfo();
    const parts = [`${fmt(rows.length)} dari ${fmt(all.length)} mutasi ditampilkan`];
    if (saldoAwal !== 0) parts.push(`saldo sebelum mutasi pertama ${cardQtyWithUnit(saldoAwal)}`);
    parts.push(`saldo akhir ${cardQtyWithUnit(item.stock_qty)}`);
    if (isi > 0) parts.push(`1 ${drumLabel} = ${fmt(isi)} ${baseLabel}`);
    if (cardIsDrum()) parts.push('harga & total tetap rupiah per ' + baseLabel);
    if (cardState.truncated) parts.push('hanya 1.000 mutasi terakhir dimuat');
    infoEl.textContent = parts.join(' · ');
  }

  // Gulir ke bawah supaya mutasi terbaru terlihat
  const wrap = tbody.closest('.table-wrap');
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}


// Cetak kartu stok (A4 landscape, hanya baris yang sedang tampil)
function printItemCard() {
  const item = cardState.item;
  if (!item) { toast('Buka kartu stok dulu', true); return; }

  const fromEl = document.getElementById('cardDateFrom');
  const toEl   = document.getElementById('cardDateTo');
  const from = fromEl ? fromEl.value : '';
  const to   = toEl ? toEl.value : '';

  const all = [...cardState.rows].sort((a, b) => {
    const d = String(a.movement_date).localeCompare(String(b.movement_date));
    return d !== 0 ? d : (Number(a.id) - Number(b.id));
  });
  const totalSigned = all.reduce((s, m) => s + m.signed, 0);
  let running = (Number(item.stock_qty) || 0) - totalSigned;
  const rows = all
    .map(m => { running += m.signed; return { ...m, saldo_after: running }; })
    .filter(m => (!from || String(m.movement_date) >= from) && (!to || String(m.movement_date) <= to));

  const { isi, baseLabel, drumLabel } = cardUnitInfo();
  const unitLabel = cardQtyUnitLabel();
  const stokTxt = cardQtyWithUnit(item.stock_qty);
  const stokAlt = cardAltQtyWithUnit(item.stock_qty);

  const rowsHtml = rows.map(m => {
    const typeLabel = m.type === 'in' ? 'Masuk'
                    : m.type === 'out' ? 'Keluar'
                    : m.type === 'adjust' ? (m.signed < 0 ? 'Koreksi -' : 'Koreksi +')
                    : m.type;
    const jNo = m.ref_journal_id ? (cardState.journalMap[m.ref_journal_id] || '-') : '-';
    const altSaldo = cardAltQtyWithUnit(m.saldo_after);
    return `
      <tr>
        <td class="c">${fmtDate(m.movement_date)}</td>
        <td class="c">${esc(typeLabel)}</td>
        <td class="r">${m.signed > 0 ? cardFmtQty(m.signed) : ''}</td>
        <td class="r">${m.signed < 0 ? cardFmtQty(m.signed) : ''}</td>
        <td class="r${Number(m.saldo_after) < 0 ? ' neg' : ''}">${cardFmtQty(m.saldo_after)}${
          altSaldo ? `<div class="alt">${esc(altSaldo)}</div>` : ''}</td>
        <td class="r">${perms.viewPrice ? fmt(m.unit_cost) : '-'}</td>
        <td class="r">${perms.viewPrice ? fmt(m.total_cost) : '-'}</td>
        <td>${esc(jNo)}</td>
        <td class="memo">${esc(m.memo || '')}</td>
      </tr>`;
  }).join('') || '<tr><td colspan="9" class="c">Tidak ada mutasi</td></tr>';


  const html = `<!DOCTYPE html>
<html lang="id"><head><meta charset="UTF-8">
<title>Kartu Stok ${esc(item.sku)}</title>
<style>
  @page { size: A4 landscape; margin: 10mm 8mm; }
  html, body { margin: 0; padding: 0; background: #f3f4f6; }
  * { box-sizing: border-box; }
  .sheet { width: 297mm; min-height: 210mm; margin: 12px auto; padding: 10mm 8mm; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.15); font-family: Arial, Helvetica, sans-serif; font-size: 9px; color: #000; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px; }
  .head h1 { font-size: 13px; margin: 0 0 3px; letter-spacing: .3px; }
  .head .meta { font-size: 9px; line-height: 1.4; }
  .head .meta b { display: inline-block; min-width: 60px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #000; padding: 2px 3px; vertical-align: top; font-size: 8.5px; }
  th { background: #eee; font-weight: 700; }
  td.c { text-align: center; } td.r { text-align: right; }
  td.neg { color: #b91c1c; }
  td.memo { font-size: 8px; }
  .alt { font-size: 7px; color: #555; white-space: nowrap; }
  thead { display: table-header-group; } tr { page-break-inside: avoid; }
  .sign { display: flex; justify-content: space-between; margin-top: 20px; page-break-inside: avoid; }
  .sign div { text-align: center; width: 30%; font-size: 9px; }
  .sign .line { margin-top: 36px; border-top: 1px solid #000; padding-top: 3px; }
  .actions { position: fixed; top: 8px; right: 8px; z-index: 10; }
  .actions button { padding: 6px 12px; font-size: 13px; cursor: pointer; }
  @media print { html, body { background: #fff; } .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; } .actions { display: none; } }
</style></head>
<body>
  <div class="actions"><button onclick="window.print()">🖨️ Cetak</button></div>
  <div class="sheet">
  <div class="head">
    <div>
      <h1>KARTU STOK</h1>
      <div class="meta">
        <div><b>SKU</b> ${esc(item.sku)}</div>
        <div><b>Nama</b> ${esc(item.name)}</div>
        <div><b>Satuan</b> ${esc(item.unit || '')}</div>
        ${isi > 0 ? `<div><b>Kemasan</b> 1 ${esc(drumLabel)} = ${fmt(isi)} ${esc(baseLabel)}</div>` : ''}
        <div><b>Tampilan qty</b> ${esc(unitLabel)}</div>
        ${(from || to)
          ? `<div><b>Periode</b> ${from ? fmtDate(from) : 'awal'} s/d ${to ? fmtDate(to) : 'akhir'}</div>`
          : ''}
      </div>
    </div>
    <div class="meta" style="text-align:right;">
      <div>Stok saat ini: <b>${esc(stokTxt)}</b>${stokAlt ? ` (${esc(stokAlt)})` : ''}</div>
      ${perms.viewPrice ? `<div>HPP rata-rata: <b>${fmt(item.avg_cost)}</b> / ${esc(baseLabel)}</div>` : ''}
      <div>Total baris: <b>${fmt(rows.length)}</b></div>
      <div>Dicetak: ${new Date().toLocaleString('id-ID')}</div>
    </div>
  </div>
  <table>
    <colgroup>
      <col style="width:64px;"><col style="width:60px;"><col style="width:64px;"><col style="width:64px;">
      <col style="width:70px;"><col style="width:64px;"><col style="width:76px;"><col style="width:96px;"><col>
    </colgroup>
    <thead>
      <tr>
        <th>Tanggal</th><th>Tipe</th><th>Masuk (${esc(unitLabel)})</th><th>Keluar (${esc(unitLabel)})</th>
        <th>Saldo (${esc(unitLabel)})</th><th>Harga / ${esc(baseLabel)}</th><th>Total</th><th>Jurnal</th><th>Memo</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="sign">
    <div><div>Dibuat oleh</div><div class="line">(____________________)</div></div>
    <div><div>Diperiksa</div><div class="line">(____________________)</div></div>
  </div>
  </div><!-- /.sheet -->
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) { toast('Popup diblokir browser. Izinkan popup untuk mencetak.', true); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

// Pasang event klik baris + kontrol modal kartu stok
function wireItemCard() {
  // Pilihan satuan terakhir diingat (operator bisa default ke drum)
  try {
    const saved = localStorage.getItem('sanno.cardUnitMode');
    if (saved === 'drum' || saved === 'base') cardState.unitMode = saved;
  } catch { /* localStorage diblokir: pakai default */ }

  const tbody = document.getElementById('tbody-inventory');
  if (tbody && !tbody.dataset.cardWired) {
    tbody.dataset.cardWired = '1';
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-sku]');
      if (tr) openItemCard(tr.dataset.sku);
    });
    tbody.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tr = e.target.closest('tr[data-sku]');
      if (tr) { e.preventDefault(); openItemCard(tr.dataset.sku); }
    });
  }

  // Riwayat mutasi global juga bisa diklik -> buka kartu stok item tsb
  const movTbody = document.getElementById('tbody-movements');
  if (movTbody && !movTbody.dataset.cardWired) {
    movTbody.dataset.cardWired = '1';
    movTbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-sku]');
      if (tr && tr.dataset.sku) openItemCard(tr.dataset.sku);
    });
  }

  const modal = document.getElementById('itemCardModal');
  if (modal && !modal.dataset.cardWired) {
    modal.dataset.cardWired = '1';
    document.getElementById('closeItemCardBtn')?.addEventListener('click', closeItemCard);
    document.getElementById('cardFilterBtn')?.addEventListener('click', renderItemCard);
    document.getElementById('cardResetBtn')?.addEventListener('click', () => {
      const f = document.getElementById('cardDateFrom');
      const t = document.getElementById('cardDateTo');
      if (f) f.value = '';
      if (t) t.value = '';
      renderItemCard();
    });
    document.getElementById('cardPrintBtn')?.addEventListener('click', printItemCard);
    document.getElementById('cardUnitBase')?.addEventListener('click', () => setCardUnitMode('base'));
    document.getElementById('cardUnitDrum')?.addEventListener('click', () => setCardUnitMode('drum'));
    document.getElementById('cardDateFrom')?.addEventListener('change', renderItemCard);
    document.getElementById('cardDateTo')?.addEventListener('change', renderItemCard);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeItemCard(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.style.display === 'flex') closeItemCard();
    });
  }
}

// ---------- dropdown stok masuk ----------
async function loadItemsForDropdown() {
  if (!perms.stockIn) return;
  try {
    allItems = await listItems();
    const sel = document.getElementById('stockInItem');
    if (!sel) return;
    sel.innerHTML = '<option value="">— pilih item —</option>' +
      allItems.map(i => {
        const isiKg  = Number(i.packaging_isi_kg)  || 0;
        const isiLtr = Number(i.packaging_isi_ltr) || 0;
        const unit = (i.unit || '').toLowerCase();
        const isi = unit === 'ltr' ? isiLtr : isiKg;
        const unitLabel = unit === 'ltr' ? 'ltr' : 'kg';
        const drumInfo = isi > 0
          ? ` · ${(Number(i.stock_qty)/isi).toLocaleString('id-ID', {maximumFractionDigits:2})} ${(i.packaging_nama||'drum').toLowerCase()}`
          : '';
        return `<option value="${i.id}">${esc(i.sku)} — ${esc(i.name)} (stok: ${Number(i.stock_qty).toLocaleString('id-ID')} ${unitLabel}${drumInfo})</option>`;
      }).join('');
  } catch (err) {
    console.error('loadItemsForDropdown:', err);
  }
}

// ---------- movements ----------
async function renderMovements() {
  const tbody = document.getElementById('tbody-movements');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  try {
    const { data, error } = await supabase
      .from('stock_movements')
      .select('id, movement_date, type, qty, unit_cost, total_cost, memo, items!inner(sku, name)')
      .order('movement_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(100);
    if (error) throw error;

    tbody.innerHTML = (data || []).map(m => {
      const priceCols = perms.viewPrice
        ? `<td data-label="Harga" class="num">${fmt(m.unit_cost)}</td>
           <td data-label="Total" class="num">${fmt(m.total_cost)}</td>`
        : `<td data-label="Harga" class="num">—</td>
           <td data-label="Total" class="num">—</td>`;

      const typeLabel = m.type === 'in' ? 'Masuk'
                      : m.type === 'out' ? 'Keluar'
                      : m.type === 'adjust' ? 'Koreksi'
                      : m.type;
      const typeColor = m.type === 'in' ? '#059669'
                      : m.type === 'out' ? '#b91c1c'
                      : '#6b7280';

      return `
        <tr class="row-clickable" data-sku="${esc(m.items?.sku || '')}" title="Klik untuk membuka kartu stok">
          <td data-label="Tanggal">${esc(m.movement_date)}</td>
          <td data-label="Item">${esc(m.items?.sku || '')} — ${esc(m.items?.name || '')}</td>
          <td data-label="Tipe"><span style="color:${typeColor};font-weight:600;">${esc(typeLabel)}</span></td>
          <td data-label="Qty" class="num">${fmt(m.qty)}</td>
          ${priceCols}
          <td data-label="Memo">${esc(m.memo || '—')}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Belum ada mutasi stok</td></tr>';
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

// ---------- form handlers ----------
async function onCreateItem(e) {
  e.preventDefault();
  if (!perms.create) { toast('Tidak ada akses buat item', true); return; }
  const f = e.target;
  const btn = document.getElementById('createItemBtn');
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  try {
    const unitVal = (f.unit.value || '').trim();
    if (!unitVal) throw new Error('Satuan wajib dipilih');
    await createItem({
      sku: f.sku.value.trim(),
      name: f.name.value.trim(),
      unit: unitVal,
      min_stock: Number(f.min_stock.value) || 0
    });
    toast('✓ Item baru dibuat (stok 0)');
    f.reset();
    const pcsOpt = [...f.unit.options].find(o => o.value === 'pcs');
    f.unit.value = pcsOpt ? 'pcs' : '';
    f.min_stock.value = 0;
    await loadAll();
  } catch (err) {
    toast('Gagal: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan Item';
  }
}

async function onStockIn(e) {
  e.preventDefault();
  if (!perms.stockIn) { toast('Tidak ada akses stok masuk', true); return; }
  const f = e.target;
  const btn = document.getElementById('stockInBtn');
  btn.disabled = true;
  btn.textContent = 'Menambah...';
  try {
    const { error } = await supabase.rpc('add_stock_in', {
      p_item_id: Number(f.item_id.value),
      p_qty: Number(f.qty.value),
      p_unit_cost: Number(f.unit_cost.value),
      p_movement_date: f.movement_date.value,
      p_memo: f.memo.value.trim() || null
    });
    if (error) throw error;
    toast('✓ Stok berhasil ditambahkan');
    f.qty.value = '';
    f.unit_cost.value = '';
    f.memo.value = '';
    await loadAll();
  } catch (err) {
    toast('Gagal: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Tambah Stok';
  }
}

// ============================================================
// TAB KOREKSI STOK
// ============================================================
async function initStockAdjustTab() {
  const formCard = document.getElementById('stock-adjust-form-card');
  if (!perms.stockAdjust && formCard) formCard.style.display = 'none';

  const dateEl = document.getElementById('saDate');
  if (dateEl) {
    dateEl.value = todayISO();
    dateEl.max = todayISO();
  }

  await loadItemsForAdjust();
  if (perms.stockAdjust) wireStockAdjustForm();
  wireStockAdjustHistory();
  await reloadStockAdjust();
}

async function loadItemsForAdjust() {
  const sel = document.getElementById('saItemId');
  if (!sel) return;
  try {
    allItemsForAdjust = await listItems();
    sel.innerHTML = '<option value="">— pilih item —</option>' +
      allItemsForAdjust
        .filter(i => i.is_active !== false)
        .map(i => `<option value="${i.id}">${esc(i.sku)} — ${esc(i.name)}</option>`)
        .join('');
  } catch (err) {
    console.error('loadItemsForAdjust:', err);
    toast('Gagal memuat daftar item: ' + (err.message || err), true);
  }
}

function wireStockAdjustForm() {
  const form = document.getElementById('form-stock-adjust');
  if (!form) return;
  const selItem = document.getElementById('saItemId');
  const qtySystem = document.getElementById('saQtySystem');
  const qtyAfter = document.getElementById('saQtyAfter');
  const deltaEl = document.getElementById('saDelta');
  const btn = document.getElementById('saSubmitBtn');

  const recompute = () => {
    const itemId = Number(selItem.value);
    const item = allItemsForAdjust.find(i => Number(i.id) === itemId);
    const sys = item ? Number(item.stock_qty) : 0;
    qtySystem.value = item ? fmt(sys) : '';
    const afterRaw = qtyAfter.value;
    if (afterRaw === '' || itemId === 0) {
      deltaEl.value = '';
      btn.disabled = true;
      return;
    }
    const after = Number(afterRaw);
    const delta = after - sys;
    deltaEl.value = (delta > 0 ? '+' : '') + fmt(delta);
    deltaEl.style.color = delta === 0 ? '#6b7280' : (delta > 0 ? '#059669' : '#b91c1c');
    btn.disabled = (delta === 0)
      || !document.getElementById('saReason').value
      || !document.getElementById('saDate').value;
  };

  selItem.addEventListener('change', recompute);
  qtyAfter.addEventListener('input', recompute);
  document.getElementById('saReason').addEventListener('change', recompute);
  document.getElementById('saDate').addEventListener('change', recompute);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!perms.stockAdjust) { toast('Tidak ada akses koreksi stok', true); return; }
    btn.disabled = true;
    btn.textContent = 'Menyimpan...';
    try {
      const { data, error } = await supabase.rpc('adjust_stock_item', {
        p_item_id:     Number(selItem.value),
        p_qty_after:   Number(qtyAfter.value),
        p_reason:      document.getElementById('saReason').value,
        p_memo:        document.getElementById('saMemo').value.trim() || null,
        p_adjust_date: document.getElementById('saDate').value
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const d = Number(row?.qty_delta ?? 0);
      toast(`✓ Stok dikoreksi (${d > 0 ? '+' : ''}${fmt(d)})`);

      form.reset();
      document.getElementById('saMemo').value = '';
      document.getElementById('saQtySystem').value = '';
      document.getElementById('saDelta').value = '';
      document.getElementById('saDate').value = todayISO();
      btn.disabled = true;

      await Promise.all([reloadStockAdjust(), renderInventory()]);
    } catch (err) {
      toast('Gagal koreksi: ' + (err.message || err), true);
    } finally {
      btn.textContent = 'Koreksi Stok';
    }
  });
}

function wireStockAdjustHistory() {
  const inpSearch = document.getElementById('saSearch');
  const fromEl = document.getElementById('saFrom');
  const toEl = document.getElementById('saTo');
  const chkUnjournaled = document.getElementById('saOnlyUnjournaled');
  const refreshBtn = document.getElementById('saRefreshBtn');
  const moreBtn = document.getElementById('saMoreBtn');

  if (inpSearch) {
    let t = null;
    inpSearch.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        adjustFilter.search = inpSearch.value.trim();
        await reloadStockAdjust();
      }, 300);
    });
  }
  if (fromEl) fromEl.addEventListener('change', async () => { adjustFilter.from = fromEl.value; await reloadStockAdjust(); });
  if (toEl)   toEl.addEventListener('change',   async () => { adjustFilter.to   = toEl.value;   await reloadStockAdjust(); });
  if (chkUnjournaled) chkUnjournaled.addEventListener('change', async () => {
    adjustFilter.onlyUnjournaled = chkUnjournaled.checked;
    // Filter dijalankan di sisi klien, jadi semua halaman harus termuat dulu.
    // Kalau tidak, koreksi "belum dijurnal" di halaman berikutnya tidak ikut tampil.
    if (adjustFilter.onlyUnjournaled) await loadAllStockAdjustPages();
    renderStockAdjustRows(adjustTotalCount);
  });
  if (refreshBtn) refreshBtn.addEventListener('click', () => reloadStockAdjust());
  if (moreBtn)    moreBtn.addEventListener('click', () => loadStockAdjust(true));

  const postAllBtn = document.getElementById('saPostAllBtn');
  if (postAllBtn) {
    postAllBtn.style.display = perms.stockAdjustPost ? 'inline-block' : 'none';
    postAllBtn.addEventListener('click', onPostAllAdjustments);
  }

  // Tombol "Posting" / "Batal" di kolom Jurnal (delegasi, karena baris dirender ulang).
  const tbody = document.getElementById('tbody-stock-adjust');
  if (tbody) {
    tbody.addEventListener('click', async (e) => {
      const btnPost = e.target.closest('[data-post-adjust]');
      if (btnPost) {
        await postStockAdjustments({ ids: [Number(btnPost.dataset.postAdjust)] });
        return;
      }
      const btnUnpost = e.target.closest('[data-unpost-journal]');
      if (btnUnpost) {
        await unpostStockAdjustmentJournal(Number(btnUnpost.dataset.unpostJournal));
      }
    });
  }
}

async function reloadStockAdjust() {
  adjustOffset = 0;
  const tbody = document.getElementById('tbody-stock-adjust');
  if (tbody) tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  const moreBtn = document.getElementById('saMoreBtn');
  if (moreBtn) moreBtn.style.display = 'none';
  const info = document.getElementById('saInfo');
  if (info) info.textContent = '';
  adjustRowsCache = [];
  await loadStockAdjust(false);
  // Filter "hanya belum dijurnal" dijalankan di sisi klien -> muat semua halaman
  // supaya hasilnya tidak terpotong pada 50 baris pertama.
  if (adjustFilter.onlyUnjournaled) await loadAllStockAdjustPages();
}

// Muat sisa halaman koreksi stok satu per satu.
async function loadAllStockAdjustPages() {
  let guard = 0;
  while (adjustOffset < adjustTotalCount && guard < 100) {
    const before = adjustOffset;
    await loadStockAdjust(true);
    if (adjustOffset === before) break; // gagal memuat -> berhenti, jangan loop
    guard += 1;
  }
}

async function loadStockAdjust(append = false) {
  const tbody = document.getElementById('tbody-stock-adjust');
  if (!tbody) return;
  if (!append) tbody.innerHTML = '';
  const seq = ++adjustReqSeq;
  try {
    const { data, error } = await supabase.rpc('list_stock_adjustments', {
      p_search: adjustFilter.search || null,
      p_from:   adjustFilter.from   || null,
      p_to:     adjustFilter.to     || null,
      p_limit:  ADJUST_LIMIT,
      p_offset: adjustOffset
    });
    if (error) throw error;
    if (seq !== adjustReqSeq) return;

    const rows = data || [];
    const totalCount = rows[0]?.total_count != null ? Number(rows[0].total_count) : rows.length;

    if (append) adjustRowsCache = adjustRowsCache.concat(rows);
    else adjustRowsCache = rows;

    adjustTotalCount = totalCount;
    adjustOffset += rows.length;
    renderStockAdjustRows(totalCount);
  } catch (err) {
    tbody.innerHTML += `<tr><td colspan="11" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

function renderStockAdjustRows(totalCount) {
  const tbody = document.getElementById('tbody-stock-adjust');
  if (!tbody) return;

  let rows = adjustRowsCache;
  if (adjustFilter.onlyUnjournaled) {
    rows = rows.filter(r => r.needs_journal === true && r.journal_entry_id == null);
  }

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:#9ca3af;">Belum ada koreksi stok</td></tr>';
  } else {
    tbody.innerHTML = rows.map(r => {
      const d = Number(r.qty_delta);
      const dStr = (d > 0 ? '+' : '') + fmt(d);
      const dColor = d > 0 ? '#059669' : '#b91c1c';
      const journalBadge = renderJournalBadge(r);
      return `
        <tr>
          <td data-label="Tanggal" style="white-space:nowrap;">${esc(r.adjust_date)}</td>
          <td data-label="SKU">${esc(r.sku)}</td>
          <td data-label="Item">${esc(r.item_name)}</td>
          <td data-label="Satuan">${esc(r.unit)}</td>
          <td data-label="Sebelum" class="num">${fmt(r.qty_before)}</td>
          <td data-label="Sesudah" class="num">${fmt(r.qty_after)}</td>
          <td data-label="Delta" class="num" style="color:${dColor};font-weight:600;">${dStr}</td>
          <td data-label="Alasan">${esc(reasonLabel(r.reason))}</td>
          <td data-label="Memo">${esc(r.memo || '—')}</td>
          <td data-label="Oleh">${esc(r.created_by_name || '—')}</td>
          <td data-label="Jurnal" style="white-space:nowrap;">${journalBadge}</td>
        </tr>`;
    }).join('');
  }

  const info = document.getElementById('saInfo');
  if (info) {
    const shown = rows.length;
    const total = adjustTotalCount || totalCount;
    info.textContent = adjustFilter.onlyUnjournaled
      ? `Menampilkan ${shown} (belum dijurnal) dari ${adjustRowsCache.length} termuat`
      : `Menampilkan ${Math.min(adjustRowsCache.length, total)} dari ${total}`;
  }

  // Tombol "Muat lebih banyak" hanya berguna kalau masih ada halaman berikutnya.
  const moreBtn = document.getElementById('saMoreBtn');
  if (moreBtn) moreBtn.style.display = adjustOffset < adjustTotalCount ? 'inline-block' : 'none';
}

// ============================================================
// POSTING JURNAL KOREKSI STOK (RPC post_stock_adjustment_journal)
// 1 jurnal ADJ-YYYYMM-NNNN per tanggal:
//   stok kurang -> Dr 5-2400 Beban Selisih Stok / Cr 1-1300 Persediaan
//   stok lebih  -> Dr 1-1300 Persediaan / Cr 5-2400 Beban Selisih Stok
// ============================================================
// Panggil RPC posting koreksi stok.
// ids = null -> mode massal di server (memakai p_from / p_to).
async function rpcPostStockAdjustmentJournal({ ids = null, from = null, to = null, dryRun = false }) {
  const { data, error } = await supabase.rpc('post_stock_adjustment_journal', {
    p_ids: ids,
    p_memo: null,
    p_from: from,
    p_to: to,
    p_dry_run: dryRun
  });
  if (error) throw error;
  return data || {};
}

async function postStockAdjustments({ ids = null, from = null, to = null, isBulk = false } = {}) {
  if (!perms.stockAdjustPost) {
    toast('Tidak ada akses posting jurnal koreksi stok', true);
    return;
  }
  const list = ids
    ? ids.map(Number).filter(n => Number.isInteger(n) && n > 0)
    : null;
  if (ids && !list.length) return;

  const postAllBtn = document.getElementById('saPostAllBtn');
  if (isBulk && postAllBtn) {
    postAllBtn.disabled = true;
    postAllBtn.textContent = 'Memposting...';
  }

  try {
    const res = await rpcPostStockAdjustmentJournal({ ids: list, from, to, dryRun: false });
    const posted = Number(res.posted_count || 0);
    const zero = Number(res.zero_value_count || 0);
    const skipped = Number(res.skipped_count || 0);
    const journals = Array.isArray(res.journals) ? res.journals : [];
    const nomor = journals.map(j => j.journal_no).filter(Boolean);

    if (posted === 0 && zero === 0) {
      toast(skipped > 0
        ? 'Tidak ada yang diposting — semua koreksi sudah dijurnal'
        : 'Tidak ada yang diposting', true);
    } else if (posted === 0) {
      // Semua target bernilai Rp 0: tidak ada jurnal, hanya status yang dirapikan.
      toast(`${zero} koreksi bernilai Rp 0 ditandai "tidak perlu jurnal"` +
        (skipped > 0 ? `, ${skipped} dilewati` : ''));
    } else {
      let msg = `✓ ${posted} koreksi dijurnal (${journals.length} jurnal)`;
      if (nomor.length) msg += ': ' + nomor.join(', ');
      toast(msg);
    }
    if (zero > 0 && posted > 0) {
      setTimeout(() => toast(`${zero} koreksi bernilai Rp 0 ditandai "tidak perlu jurnal"`), 2700);
    }

    await reloadStockAdjust();
  } catch (err) {
    toast('Gagal posting: ' + (err.message || err), true);
  } finally {
    if (isBulk && postAllBtn) {
      postAllBtn.disabled = false;
      postAllBtn.textContent = 'Posting semua belum dijurnal';
    }
  }
}

async function onPostAllAdjustments() {
  if (!perms.stockAdjustPost) {
    toast('Tidak ada akses posting jurnal koreksi stok', true);
    return;
  }

  const postAllBtn = document.getElementById('saPostAllBtn');
  if (postAllBtn) {
    postAllBtn.disabled = true;
    postAllBtn.textContent = 'Menghitung...';
  }

  const from = adjustFilter.from || null;
  const to = adjustFilter.to || null;

  try {
    // Pratinjau dari server (tidak menulis) -> konfirmasi dengan angka pasti.
    const prev = await rpcPostStockAdjustmentJournal({ from, to, dryRun: true });
    const count = Number(prev.count || 0);

    if (!count) {
      toast('Tidak ada koreksi yang perlu dijurnal', true);
      return;
    }

    const locked = Array.isArray(prev.locked_dates) ? prev.locked_dates : [];
    if (locked.length) {
      toast('Tidak bisa posting: periode terkunci (' + locked.join(', ') + ')', true);
      return;
    }

    const rincian = (Array.isArray(prev.per_date) ? prev.per_date : [])
      .map(d => `  • ${d.date}: ${d.items} item — Rp ${fmt(d.value)}`)
      .join('\n');
    const rentang = (from || to)
      ? `\nFilter tanggal: ${from || '…'} s/d ${to || '…'}`
      : '';
    const nol = Number(prev.zero_value_count || 0);
    const pesan =
      `Posting ${count} koreksi stok ke jurnal?${rentang}\n\n` +
      `Total nilai selisih: Rp ${fmt(prev.total_value)}\n` +
      (rincian ? `\nRincian per tanggal:\n${rincian}\n` : '') +
      `\nDibuat 1 jurnal per tanggal (ADJ-YYYYMM-NNNN).\n` +
      (nol > 0
        ? (nol === count
            ? `⚠️ SEMUA ${count} koreksi bernilai Rp 0 — tidak ada jurnal yang dibuat, ` +
              `statusnya hanya ditandai "tidak perlu jurnal".\n`
            : `${nol} koreksi bernilai Rp 0 akan ditandai "tidak perlu jurnal".\n`)
        : '') +
      `Stok item TIDAK diubah oleh posting ini.`;
    if (!confirm(pesan)) return;

    await postStockAdjustments({ from, to, isBulk: true });
  } catch (err) {
    toast('Gagal menghitung: ' + (err.message || err), true);
  } finally {
    if (postAllBtn) {
      postAllBtn.disabled = false;
      postAllBtn.textContent = 'Posting semua belum dijurnal';
    }
  }
}

async function unpostStockAdjustmentJournal(journalId) {
  if (!perms.stockAdjustPost) {
    toast('Tidak ada akses membatalkan posting jurnal koreksi stok', true);
    return;
  }
  if (!journalId) return;

  const pesan =
    `Batalkan posting jurnal koreksi stok?\n\n` +
    `Jurnal akan DIHAPUS dan seluruh koreksi di dalamnya kembali berstatus ` +
    `"Belum dijurnal".\nStok item TIDAK berubah.`;
  if (!confirm(pesan)) return;

  try {
    const { data, error } = await supabase.rpc('unpost_stock_adjustment_journal', {
      p_journal_id: Number(journalId)
    });
    if (error) throw error;
    const res = data || {};
    toast(`✓ Posting dibatalkan (${Number(res.unposted_count || 0)} koreksi, jurnal ${res.journal_no || ''})`);
    await reloadStockAdjust();
  } catch (err) {
    toast('Gagal batalkan posting: ' + (err.message || err), true);
  }
}

// ============================================================
// TAB OPNAME MASSAL
// ============================================================
async function initOpnameTab() {
  const btnNew = document.getElementById('opnameNewBtn');
  if (btnNew) btnNew.style.display = perms.opnameCreate ? '' : 'none';

  const detail = document.getElementById('opnameDetailCard');
  if (detail) detail.style.display = 'none';

  if (perms.opnameCreate) wireOpnameCreateForm();

  const refreshTop = document.getElementById('opnameRefreshBtn');
  if (refreshTop) refreshTop.addEventListener('click', async () => {
    await reloadOpnameHistory();
    if (currentOpnameId) await loadOpnameDetail();
  });
  const refreshHist = document.getElementById('opnameHistRefreshBtn');
  if (refreshHist) refreshHist.addEventListener('click', () => reloadOpnameHistory());

  wireOpnameHistory();
  await reloadOpnameHistory();
}

function wireOpnameCreateForm() {
  const btnNew = document.getElementById('opnameNewBtn');
  const card = document.getElementById('opnameNewFormCard');
  const form = document.getElementById('form-opname-new');
  const btnCancel = document.getElementById('opnameCancelCreateBtn');
  if (!btnNew || !card || !form) return;

  const dateEl = form.querySelector('[name=opname_date]');
  if (dateEl) { dateEl.value = todayISO(); dateEl.max = todayISO(); }

  btnNew.addEventListener('click', () => {
    card.style.display = card.style.display === 'none' ? 'block' : 'none';
    if (card.style.display === 'block') {
      form.opname_date.value = todayISO();
      form.notes.value = '';
      form.opname_date.focus();
    }
  });

  if (btnCancel) btnCancel.addEventListener('click', () => {
    card.style.display = 'none';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('opnameCreateBtn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Membuat...'; }
    try {
      const { data, error } = await supabase.rpc('create_opname', {
        p_opname_date: form.opname_date.value,
        p_notes: form.notes.value.trim() || null
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      toast(`✓ Opname ${row.opname_no} dibuat (${row.line_count} item)`);
      card.style.display = 'none';
      form.reset();
      await reloadOpnameHistory();
      await openOpnameDetail(row.opname_id);
    } catch (err) {
      toast('Gagal buat opname: ' + (err.message || err), true);
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Buat Opname'; }
    }
  });
}

async function openOpnameDetail(opnameId) {
  currentOpnameId = Number(opnameId);
  const detail = document.getElementById('opnameDetailCard');
  if (detail) detail.style.display = 'block';
  await loadOpnameDetail();
}

async function loadOpnameDetail() {
  if (!currentOpnameId) return;
  const tbody = document.getElementById('tbody-opname-lines');
  const headerEl = document.getElementById('opnameDetailHeader');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';

  try {
    const { data, error } = await supabase.rpc('get_opname', { p_opname_id: currentOpnameId });
    if (error) throw error;
    const header = Array.isArray(data) ? data[0] : data;
    if (!header) throw new Error('Opname tidak ditemukan');

    opnameLinesCache = Array.isArray(header.lines) ? header.lines : [];
    window.__currentOpnameHeader = header;

    currentOpnameStatus = header.status || '';
    renderOpnameHeader(header);
    renderOpnameLines(header.status);
    renderOpnameActions(header);
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
    if (headerEl) headerEl.innerHTML = `<span style="color:#b91c1c;">${esc(err.message)}</span>`;
  }
}

function renderOpnameHeader(h) {
  const el = document.getElementById('opnameDetailHeader');
  if (!el) return;
  let journalBadge = '';
  if (h.status === 'executed') {
    if (h.journal_entry_id != null) {
      const tgl = h.journal_posted_at ? new Date(h.journal_posted_at).toLocaleDateString('id-ID') : '';
      journalBadge = `<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px;">Jurnal sudah${tgl ? ' · ' + esc(tgl) : ''}</span>`;
    } else {
      journalBadge = `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:4px;font-weight:600;font-size:12px;">Belum dijurnal</span>`;
    }
  }
  el.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;">
      <div><b>${esc(h.opname_no)}</b> ${statusBadge(h.status)} ${journalBadge}</div>
      <div>Tanggal: <b>${esc(h.opname_date)}</b></div>
      <div>Dibuat: ${esc(fmtDateTime(h.created_at))}</div>
      ${h.submitted_at ? `<div>Submit: ${esc(fmtDateTime(h.submitted_at))}</div>` : ''}
      ${h.executed_at ? `<div>Eksekusi: ${esc(fmtDateTime(h.executed_at))}</div>` : ''}
      ${h.cancel_reason ? `<div style="color:#b91c1c;">Batal: ${esc(h.cancel_reason)}</div>` : ''}
    </div>
    ${h.notes ? `<div style="margin-top:6px;color:#6b7280;font-size:13px;">Catatan: ${esc(h.notes)}</div>` : ''}
  `;
}

function renderOpnameActions(h) {
  const el = document.getElementById('opnameActionBar');
  if (!el) return;
  const s = h.status;
  const btns = [];

  if (s === 'draft') {
    btns.push(`<button type="button" class="btn btn-secondary" id="opnamePrintBtn">🖨️ Cetak Form</button>`);
    if (perms.opnameCreate) {
      btns.push(`<button type="button" class="btn btn-primary" id="opnameSaveDraftBtn">Simpan Draft</button>`);
      btns.push(`<button type="button" class="btn btn-primary" id="opnameSubmitBtn" style="background:#0891b2;">Submit</button>`);
      btns.push(`<button type="button" class="btn btn-danger" id="opnameCancelBtn">Cancel</button>`);
    }
  }
  if (s === 'submitted' && perms.opnameApprove) {
    btns.push(`<button type="button" class="btn btn-primary" id="opnameExecuteBtn" style="background:#059669;">Approve &amp; Eksekusi</button>`);
    btns.push(`<button type="button" class="btn btn-danger" id="opnameRejectBtn">Reject</button>`);
  }
  if (s === 'submitted' && perms.opnameCreate) {
    btns.push(`<button type="button" class="btn btn-danger" id="opnameCancelBtn">Cancel</button>`);
  }
  if (!btns.length) {
    el.innerHTML = `<span style="color:#6b7280;font-size:13px;">Tidak ada aksi tersedia.</span>`;
    return;
  }
  el.innerHTML = btns.join(' ');

  document.getElementById('opnameSaveDraftBtn')?.addEventListener('click', () => saveOpnameDraft());
  document.getElementById('opnameSubmitBtn')?.addEventListener('click', () => submitOpnameHandler());
  document.getElementById('opnameExecuteBtn')?.addEventListener('click', () => executeOpnameHandler());
  document.getElementById('opnameRejectBtn')?.addEventListener('click', () => rejectOpnameHandler());
  document.getElementById('opnameCancelBtn')?.addEventListener('click', () => cancelOpnameHandler());
  document.getElementById('opnamePrintBtn')?.addEventListener('click', () => printOpnameForm());
}

function renderOpnameLines(status) {
  const tbody = document.getElementById('tbody-opname-lines');
  if (!tbody) return;
  const editable = status === 'draft' && perms.opnameCreate;

  let rows = opnameLinesCache.slice();
  if (opnameFilter.search) {
    const q = opnameFilter.search.toLowerCase();
    rows = rows.filter(r =>
      String(r.sku || '').toLowerCase().includes(q) ||
      String(r.item_name || '').toLowerCase().includes(q)
    );
  }
  if (opnameFilter.onlyDelta) {
    rows = rows.filter(r => {
      if (r.qty_physical == null) return false;
      return (Number(r.qty_physical) - Number(r.qty_system)) !== 0;
    });
  }

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#9ca3af;">Tidak ada item cocok</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const sys = Number(r.qty_system);
    const phys = r.qty_physical == null ? null : Number(r.qty_physical);
    const delta = phys == null ? null : (phys - sys);
    const deltaStr = delta == null ? '' : ((delta > 0 ? '+' : '') + fmt(delta));
    const deltaColor = delta == null ? '#6b7280' : (delta === 0 ? '#6b7280' : (delta > 0 ? '#059669' : '#b91c1c'));
    const reasonOpts = ['','rusak','hilang','salah_input','lainnya'].map(v =>
      `<option value="${v}" ${v === (r.reason||'') ? 'selected' : ''}>${v ? reasonLabel(v) : '— pilih —'}</option>`
    ).join('');
    const dis = editable ? '' : 'disabled';
    return `
      <tr data-line-id="${r.line_id}">
        <td data-label="SKU">${esc(r.sku)}</td>
        <td data-label="Nama">${esc(r.item_name)}</td>
        <td data-label="Satuan">${esc(r.unit)}</td>
        <td data-label="Stok Sistem" class="num">${fmt(sys)}</td>
        <td data-label="Qty Fisik">
          <input type="number" step="0.0001" min="0" ${dis}
                 class="opname-phys" value="${phys == null ? '' : phys}"
                 style="width:100px;padding:6px;border:1px solid #d0d5dd;border-radius:6px;">
        </td>
        <td data-label="Selisih" class="num opname-delta" style="color:${deltaColor};font-weight:600;">${deltaStr}</td>
        <td data-label="Alasan">
          <select class="opname-reason" ${dis}
                  style="padding:6px;border:1px solid #d0d5dd;border-radius:6px;">${reasonOpts}</select>
        </td>
        <td data-label="Memo">
          <input type="text" ${dis} class="opname-memo" value="${esc(r.memo||'')}"
                 maxlength="500" style="width:100%;padding:6px;border:1px solid #d0d5dd;border-radius:6px;">
        </td>
      </tr>`;
  }).join('');

  if (editable) wireOpnameLineInputs();
}

function wireOpnameLineInputs() {
  document.querySelectorAll('#tbody-opname-lines tr[data-line-id]').forEach(tr => {
    const lineId = Number(tr.dataset.lineId);
    const physEl = tr.querySelector('.opname-phys');
    const deltaEl = tr.querySelector('.opname-delta');
    const line = opnameLinesCache.find(x => Number(x.line_id) === lineId);
    if (!line || !physEl) return;

    physEl.addEventListener('input', () => {
      const sys = Number(line.qty_system);
      const v = physEl.value === '' ? null : Number(physEl.value);
      line.qty_physical = v;
      if (v == null) { deltaEl.textContent = ''; deltaEl.style.color = '#6b7280'; return; }
      const d = v - sys;
      deltaEl.textContent = (d > 0 ? '+' : '') + fmt(d);
      deltaEl.style.color = d === 0 ? '#6b7280' : (d > 0 ? '#059669' : '#b91c1c');
    });
    tr.querySelector('.opname-reason')?.addEventListener('change', (e) => { line.reason = e.target.value; });
    tr.querySelector('.opname-memo')?.addEventListener('input', (e) => { line.memo = e.target.value; });
  });
}

// Kirim SEMUA line (bukan hanya yang terisi). Kalau line yang sudah pernah
// disimpan lalu dikosongkan tidak ikut dikirim, DB tetap menyimpan qty lama
// sehingga opname bisa mengeksekusi selisih yang sudah dibatalkan user.
// qty_physical null akan di-set NULL oleh save_opname_lines().
function collectOpnameLinePayload() {
  return opnameLinesCache.map(l => ({
    line_id: l.line_id,
    qty_physical: (l.qty_physical == null || l.qty_physical === '')
      ? null
      : Number(l.qty_physical),
    reason: l.reason || null,
    memo: l.memo || null
  }));
}

async function saveOpnameDraft() {
  if (!perms.opnameCreate) { toast('Tidak ada akses', true); return; }
  const btn = document.getElementById('opnameSaveDraftBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }
  try {
    const { data, error } = await supabase.rpc('save_opname_lines', {
      p_opname_id: currentOpnameId,
      p_lines: collectOpnameLinePayload()
    });
    if (error) throw error;
    const saved = Array.isArray(data) ? (data[0]?.saved_count ?? 0) : (data?.saved_count ?? 0);
    toast(`✓ Draft tersimpan (${saved} line)`);
    await loadOpnameDetail();
  } catch (err) {
    toast('Gagal simpan: ' + (err.message || err), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Simpan Draft'; }
  }
}

function printOpnameForm() {
  if (!currentOpnameId) return;
  const h = window.__currentOpnameHeader || {};
  const tanggal = h.opname_date || '';
  const catatan = h.notes || '';

  const shortName = (s, max = 40) => {
    const str = String(s || '');
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  };

  const rowsHtml = opnameLinesCache.map((r, idx) => {
    const sys = Number(r.qty_system);
    const phys = r.qty_physical == null ? '' : Number(r.qty_physical);
    const delta = (r.qty_physical == null) ? '' : (Number(r.qty_physical) - sys);
    const fullName = r.item_name || '';
    return `
      <tr>
        <td class="c">${idx + 1}</td>
        <td class="sku">${esc(r.sku)}</td>
        <td title="${esc(fullName)}">${esc(shortName(fullName))}</td>
        <td class="c">${esc(r.unit)}</td>
        <td class="r">${fmt(sys)}</td>
        <td class="phys">${phys === '' ? '' : fmt(phys)}</td>
        <td class="r">${delta === '' ? '' : ((delta > 0 ? '+' : '') + fmt(delta))}</td>
        <td class="c">${r.reason ? esc(reasonLabel(r.reason).charAt(0)) : ''}</td>
        <td class="memo">${esc(r.memo || '')}</td>
      </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="id"><head><meta charset="UTF-8">
<title>Form Opname ${esc(h.opname_no || '')}</title>
<style>
  @page { size: A4 portrait; margin: 10mm 8mm; }
  html, body { margin: 0; padding: 0; background: #f3f4f6; }
  * { box-sizing: border-box; }
  .sheet { width: 210mm; min-height: 297mm; margin: 12px auto; padding: 10mm 8mm; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.15); font-family: Arial, Helvetica, sans-serif; font-size: 9px; color: #000; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px; }
  .head h1 { font-size: 13px; margin: 0 0 3px; letter-spacing: .3px; }
  .head .meta { font-size: 9px; line-height: 1.4; }
  .head .meta b { display: inline-block; min-width: 52px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #000; padding: 2px 3px; vertical-align: top; font-size: 8.5px; }
  th { background: #eee; font-weight: 700; font-size: 8.5px; }
  td.c { text-align: center; } td.r { text-align: right; }
  td.sku { font-family: "Courier New", monospace; font-size: 8px; word-break: break-all; }
  td.memo { font-size: 8px; } td.phys { background: #fff; }
  thead { display: table-header-group; } tr { page-break-inside: avoid; }
  .legend { margin-top: 6px; font-size: 8.5px; }
  .sign { display: flex; justify-content: space-between; margin-top: 24px; page-break-inside: avoid; }
  .sign div { text-align: center; width: 40%; font-size: 9px; }
  .sign .line { margin-top: 40px; border-top: 1px solid #000; padding-top: 3px; }
  .actions { position: fixed; top: 8px; right: 8px; z-index: 10; }
  .actions button { padding: 6px 12px; font-size: 13px; cursor: pointer; }
  @media print { html, body { background: #fff; } .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; } .actions { display: none; } }
</style></head>
<body>
  <div class="actions"><button onclick="window.print()">🖨️ Cetak</button></div>
  <div class="sheet">
  <div class="head">
    <div>
      <h1>FORM OPNAME MASSAL</h1>
      <div class="meta">
        <div><b>No.</b> ${esc(h.opname_no || '')}</div>
        <div><b>Tanggal</b> ${esc(tanggal)}</div>
        ${catatan ? `<div><b>Catatan</b> ${esc(catatan)}</div>` : ''}
      </div>
    </div>
    <div class="meta" style="text-align:right;">
      <div>Total item: <b>${opnameLinesCache.length}</b></div>
      <div>Dicetak: ${new Date().toLocaleString('id-ID')}</div>
    </div>
  </div>
  <table>
    <colgroup>
      <col style="width:24px;"><col style="width:70px;"><col><col style="width:36px;">
      <col style="width:52px;"><col style="width:60px;"><col style="width:52px;">
      <col style="width:38px;"><col style="width:80px;">
    </colgroup>
    <thead>
      <tr>
        <th>No</th><th>SKU</th><th>Nama</th><th>Sat.</th>
        <th>Stok<br>Sistem</th><th>Qty<br>Fisik</th><th>Selisih</th>
        <th>Alasan</th><th>Memo</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="legend">Kode alasan: <b>R</b> = Rusak, <b>H</b> = Hilang, <b>S</b> = Salah input, <b>L</b> = Lainnya.</div>
  <div class="sign">
    <div><div>Petugas Opname</div><div class="line">(____________________)</div></div>
    <div><div>Penyelia / Supervisor</div><div class="line">(____________________)</div></div>
  </div>
  </div><!-- /.sheet -->
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) { toast('Popup diblokir browser. Izinkan popup untuk mencetak.', true); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

async function submitOpnameHandler() {
  if (!perms.opnameCreate) { toast('Tidak ada akses', true); return; }
  if (!confirm('Submit opname ini? Setelah submit, qty fisik tidak bisa diedit.')) return;
  const btn = document.getElementById('opnameSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Submit...'; }
  try {
    const { error: eSave } = await supabase.rpc('save_opname_lines', {
      p_opname_id: currentOpnameId,
      p_lines: collectOpnameLinePayload()
    });
    if (eSave) throw eSave;
    const { error } = await supabase.rpc('submit_opname', { p_opname_id: currentOpnameId });
    if (error) throw error;
    toast('✓ Opname submitted');
    await loadOpnameDetail();
    await reloadOpnameHistory();
  } catch (err) {
    toast('Gagal submit: ' + (err.message || err), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Submit'; }
  }
}

async function executeOpnameHandler() {
  if (!perms.opnameApprove) { toast('Tidak ada akses eksekusi', true); return; }
  const rowsWithDelta = opnameLinesCache.filter(l => {
    if (l.qty_physical == null) return false;
    return Number(l.qty_physical) !== Number(l.qty_system);
  });
  const msg = `Approve & eksekusi opname ini?\n\n${rowsWithDelta.length} item akan di-adjust.`;
  if (!confirm(msg)) return;
  const btn = document.getElementById('opnameExecuteBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Mengeksekusi...'; }
  try {
    const { data, error } = await supabase.rpc('execute_opname', { p_opname_id: currentOpnameId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    toast(`✓ Eksekusi selesai: ${row.adjusted_count} adjust, ${row.skipped_count} dilewati`);
    await loadOpnameDetail();
    await reloadOpnameHistory();
    if (opnameInitialized) await renderInventory();
  } catch (err) {
    toast('Gagal eksekusi: ' + (err.message || err), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Approve & Eksekusi'; }
  }
}

async function rejectOpnameHandler() {
  if (!perms.opnameApprove) { toast('Tidak ada akses', true); return; }
  const reason = prompt('Alasan reject (opsional):', '');
  if (reason === null) return;
  const btn = document.getElementById('opnameRejectBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Reject...'; }
  try {
    const { error } = await supabase.rpc('reject_opname', {
      p_opname_id: currentOpnameId,
      p_reason: reason || null
    });
    if (error) throw error;
    toast('✓ Opname ditolak, kembali ke draft');
    await loadOpnameDetail();
    await reloadOpnameHistory();
  } catch (err) {
    toast('Gagal reject: ' + (err.message || err), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Reject'; }
  }
}

async function cancelOpnameHandler() {
  if (!perms.opnameCreate) { toast('Tidak ada akses', true); return; }
  const reason = prompt('Alasan cancel (opsional):', '');
  if (reason === null) return;
  if (!confirm('Batalkan opname ini? Tidak bisa dikembalikan.')) return;
  const btn = document.getElementById('opnameCancelBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Membatalkan...'; }
  try {
    const { error } = await supabase.rpc('cancel_opname', {
      p_opname_id: currentOpnameId,
      p_reason: reason || null
    });
    if (error) throw error;
    toast('✓ Opname dibatalkan');
    await loadOpnameDetail();
    await reloadOpnameHistory();
  } catch (err) {
    toast('Gagal cancel: ' + (err.message || err), true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Cancel'; }
  }
}

function wireOpnameLinesFilter() {
  const searchEl = document.getElementById('opnameLineSearch');
  const chkDelta = document.getElementById('opnameOnlyDiff');

  if (searchEl) {
    let t = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        opnameFilter.search = searchEl.value.trim();
        if (currentOpnameId) renderOpnameLines(currentOpnameStatus);
      }, 250);
    });
  }
  if (chkDelta) {
    chkDelta.addEventListener('change', () => {
      opnameFilter.onlyDelta = chkDelta.checked;
      if (currentOpnameId) renderOpnameLines(currentOpnameStatus);
    });
  }
}

function wireOpnameHistory() {
  const searchEl = document.getElementById('opnameHistSearch');
  const statusEl = document.getElementById('opnameHistStatus');
  const fromEl = document.getElementById('opnameHistFrom');
  const toEl = document.getElementById('opnameHistTo');
  const moreBtn = document.getElementById('opnameHistMoreBtn');

  if (searchEl) {
    let t = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        opnameHistFilter.search = searchEl.value.trim();
        await reloadOpnameHistory();
      }, 300);
    });
  }
  if (statusEl) statusEl.addEventListener('change', async () => {
    opnameHistFilter.status = statusEl.value;
    await reloadOpnameHistory();
  });
  if (fromEl) fromEl.addEventListener('change', async () => {
    opnameHistFilter.from = fromEl.value;
    await reloadOpnameHistory();
  });
  if (toEl) toEl.addEventListener('change', async () => {
    opnameHistFilter.to = toEl.value;
    await reloadOpnameHistory();
  });
  if (moreBtn) moreBtn.addEventListener('click', () => loadOpnameHistory(true));

  wireOpnameLinesFilter();
}

async function reloadOpnameHistory() {
  opnameHistOffset = 0;
  const tbody = document.getElementById('tbody-opname-history');
  if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  const moreBtn = document.getElementById('opnameHistMoreBtn');
  if (moreBtn) moreBtn.style.display = 'none';
  const info = document.getElementById('opnameHistInfo');
  if (info) info.textContent = '';
  await loadOpnameHistory(false);
}

async function loadOpnameHistory(append = false) {
  const tbody = document.getElementById('tbody-opname-history');
  if (!tbody) return;
  if (!append) tbody.innerHTML = '';
  const seq = ++opnameHistReqSeq;
  try {
    const { data, error } = await supabase.rpc('list_stock_opnames', {
      p_search: opnameHistFilter.search || null,
      p_status: opnameHistFilter.status || null,
      p_from:   opnameHistFilter.from   || null,
      p_to:     opnameHistFilter.to     || null,
      p_limit:  OPNAME_HIST_LIMIT,
      p_offset: opnameHistOffset
    });
    if (error) throw error;
    if (seq !== opnameHistReqSeq) return;

    const rows = data || [];
    const totalCount = rows[0]?.total_count != null ? Number(rows[0].total_count) : rows.length;

    if (!append && !rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#9ca3af;">Belum ada opname</td></tr>';
      return;
    }

    const html = rows.map(r => `
      <tr>
        <td data-label="No"><b>${esc(r.opname_no)}</b></td>
        <td data-label="Tanggal">${esc(r.opname_date)}</td>
        <td data-label="Status">${statusBadge(r.status)}</td>
        <td data-label="Line" class="num">${fmt(r.line_count)}</td>
        <td data-label="Adjust" class="num" style="color:#059669;font-weight:600;">${Number(r.adjusted_count)||0}</td>
        <td data-label="Skip" class="num" style="color:#6b7280;">${Number(r.skipped_count)||0}</td>
        <td data-label="Dibuat">${esc(fmtDateTime(r.created_at))}</td>
        <td data-label="Eksekusi">${r.executed_at ? esc(fmtDateTime(r.executed_at)) : '—'}</td>
        <td data-label="Aksi">
          <button type="button" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;"
                  data-open-opname="${r.id}">Lihat</button>
        </td>
      </tr>`).join('');

    if (append) tbody.insertAdjacentHTML('beforeend', html);
    else tbody.innerHTML = html;

    tbody.querySelectorAll('[data-open-opname]').forEach(btn => {
      btn.addEventListener('click', () => openOpnameDetail(Number(btn.dataset.openOpname)));
    });

    opnameHistOffset += rows.length;
    const info = document.getElementById('opnameHistInfo');
    if (info) info.textContent = `Menampilkan ${Math.min(opnameHistOffset, totalCount)} dari ${totalCount}`;
    const moreBtn = document.getElementById('opnameHistMoreBtn');
    if (moreBtn) moreBtn.style.display = opnameHistOffset < totalCount ? 'inline-block' : 'none';
  } catch (err) {
    tbody.innerHTML += `<tr><td colspan="9" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

// ============================================================
// TAB PRICE LIST
// ============================================================
async function initPriceListTab() {
  if (!perms.priceListManage) {
    const reasonEl = document.getElementById('plReason');
    if (reasonEl) reasonEl.style.display = 'none';
    const saveBtn = document.getElementById('plSaveBtn');
    if (saveBtn) saveBtn.style.display = 'none';
  }

  wirePriceListToolbar();
  wirePriceListHistory();
  await Promise.all([reloadPriceList(), reloadPriceListHistory()]);
}

function wirePriceListToolbar() {
  const searchEl = document.getElementById('plSearch');
  const chkOnly = document.getElementById('plOnlyWithPrice');
  const refreshBtn = document.getElementById('plRefreshBtn');
  const printBtn = document.getElementById('plPrintBtn');
  const moreBtn = document.getElementById('plMoreBtn');
  const saveBtn = document.getElementById('plSaveBtn');
  const reasonEl = document.getElementById('plReason');

  if (searchEl) {
    let t = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        priceListFilter.search = searchEl.value.trim();
        await reloadPriceList();
      }, 300);
    });
  }
  if (chkOnly) {
    chkOnly.addEventListener('change', async () => {
      priceListFilter.onlyWithPrice = chkOnly.checked;
      await reloadPriceList();
    });
  }
  if (refreshBtn) refreshBtn.addEventListener('click', () => reloadPriceList());
  if (printBtn)   printBtn.addEventListener('click', () => printPriceListForm());
  if (moreBtn)    moreBtn.addEventListener('click', () => loadPriceList(true));
  if (reasonEl)   reasonEl.addEventListener('input', updatePriceListSaveBtn);
  if (saveBtn)    saveBtn.addEventListener('click', () => savePriceListHandler('bulk'));
}

async function reloadPriceList() {
  priceListOffset = 0;
  priceListDirty = new Set();
  priceListRowsCache = [];
  const tbody = document.getElementById('tbody-price-list');
  if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  const moreBtn = document.getElementById('plMoreBtn');
  if (moreBtn) moreBtn.style.display = 'none';
  const info = document.getElementById('plInfo');
  if (info) info.textContent = '';
  updatePriceListSaveBtn();
  await loadPriceList(false);
}

async function loadPriceList(append = false) {
  const tbody = document.getElementById('tbody-price-list');
  if (!tbody) return;
  if (!append) tbody.innerHTML = '';
  const seq = ++priceListReqSeq;

  try {
    const { data, error } = await supabase.rpc('list_price_list', {
      p_search: priceListFilter.search || null,
      p_only_with_price: priceListFilter.onlyWithPrice,
      p_limit: PRICE_LIST_LIMIT,
      p_offset: priceListOffset
    });
    if (error) throw error;
    if (seq !== priceListReqSeq) return;

    const rows = data || [];
    const totalCount = rows[0]?.total_count != null ? Number(rows[0].total_count) : rows.length;

    if (append) priceListRowsCache = priceListRowsCache.concat(rows);
    else priceListRowsCache = rows;

    priceListTotalCount = totalCount;
    priceListOffset += rows.length;

    renderPriceListRows();
  } catch (err) {
    tbody.innerHTML += `<tr><td colspan="9" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

function renderPriceListRows() {
  const tbody = document.getElementById('tbody-price-list');
  if (!tbody) return;

  if (!priceListRowsCache.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#9ca3af;">Tidak ada item cocok</td></tr>';
    updatePriceListSaveBtn();
    return;
  }

  const canManage = perms.priceListManage;

  tbody.innerHTML = priceListRowsCache.map(r => {
    const itemId = Number(r.item_id);
    const hasPrice = r.has_price === true;
    const priceVal = hasPrice ? Number(r.price) : '';
    const discVal  = hasPrice ? Number(r.discount_pct) : 0;
    const effVal   = hasPrice ? Number(r.effective_price) : 0;
    const dis = canManage ? '' : 'disabled';
    const isDirty = priceListDirty.has(itemId);

    return `
      <tr data-item-id="${itemId}" class="${isDirty ? 'pl-dirty' : ''}"
          style="${isDirty ? 'background:#fef3c7;' : ''}">
        <td data-label="SKU">${esc(r.sku)}</td>
        <td data-label="Nama">${esc(r.item_name)}</td>
        <td data-label="Satuan">${esc(r.unit)}</td>
        <td data-label="Harga" class="num">
          <input type="number" step="0.01" min="0" ${dis}
                 class="pl-price" value="${priceVal === '' ? '' : priceVal}"
                 placeholder="${hasPrice ? '' : '—'}"
                 style="width:180px;min-width:180px;padding:10px 12px;font-size:15px;border:1px solid #d0d5dd;border-radius:6px;text-align:right;box-sizing:border-box;">
        </td>
        <td data-label="Diskon %" class="num">
          <input type="number" step="0.01" min="0" max="100" ${dis}
                 class="pl-disc" value="${discVal}"
                 style="width:80px;min-width:80px;padding:10px 8px;font-size:15px;border:1px solid #d0d5dd;border-radius:6px;text-align:right;box-sizing:border-box;">
        </td>
        <td data-label="Harga Efektif" class="num pl-eff" style="font-weight:600;white-space:nowrap;${hasPrice ? '' : 'color:#9ca3af;'}">
          ${hasPrice ? fmt(effVal) : '—'}
        </td>
        <td data-label="Diperbarui" style="white-space:nowrap;">
          ${hasPrice ? esc(fmtDateTime(r.updated_at)) : '—'}
        </td>
        <td data-label="Riwayat">
          <button type="button" class="btn btn-secondary pl-hist-btn"
                  data-item-id="${itemId}" style="padding:4px 10px;font-size:12px;">Riwayat</button>
        </td>
        <td data-label="Aksi">
          ${canManage ? `
            <button type="button" class="btn btn-primary pl-save-one"
                    data-item-id="${itemId}" disabled
                    style="padding:4px 10px;font-size:12px;margin-right:4px;">Simpan</button>
            ${hasPrice ? `
              <button type="button" class="btn btn-danger pl-delete"
                      data-item-id="${itemId}" data-sku="${esc(r.sku)}"
                      style="padding:4px 10px;font-size:12px;">Hapus</button>
            ` : ''}
          ` : '<span style="color:#9ca3af;">—</span>'}
        </td>
      </tr>`;
  }).join('');

  wirePriceListInputs();

  const info = document.getElementById('plInfo');
  if (info) info.textContent = `Menampilkan ${Math.min(priceListOffset, priceListTotalCount)} dari ${priceListTotalCount}`;
  const moreBtn = document.getElementById('plMoreBtn');
  if (moreBtn) moreBtn.style.display = priceListOffset < priceListTotalCount ? 'inline-block' : 'none';

  updatePriceListSaveBtn();
}

function updatePriceListSaveBtn() {
  const saveBtn = document.getElementById('plSaveBtn');
  if (!saveBtn) return;
  saveBtn.disabled = priceListDirty.size === 0;
  saveBtn.textContent = priceListDirty.size > 0
    ? `Simpan Perubahan (${priceListDirty.size})`
    : 'Simpan Perubahan';
}

function wirePriceListInputs() {
  const tbody = document.getElementById('tbody-price-list');
  if (!tbody) return;

  tbody.querySelectorAll('tr[data-item-id]').forEach(tr => {
    const itemId = Number(tr.dataset.itemId);
    const priceEl = tr.querySelector('.pl-price');
    const discEl  = tr.querySelector('.pl-disc');
    const effEl   = tr.querySelector('.pl-eff');
    const saveOneBtn = tr.querySelector('.pl-save-one');
    const histBtn = tr.querySelector('.pl-hist-btn');
    const delBtn  = tr.querySelector('.pl-delete');

    const row = priceListRowsCache.find(x => Number(x.item_id) === itemId);
    if (!row) return;

    const origPrice = row.has_price ? Number(row.price) : null;
    const origDisc  = row.has_price ? Number(row.discount_pct) : 0;

    const recompute = () => {
      const priceRaw = priceEl?.value ?? '';
      const discRaw  = discEl?.value ?? '';
      const price = priceRaw === '' ? null : Number(priceRaw);
      const disc  = discRaw === '' ? 0 : Number(discRaw);

      if (effEl) {
        if (price == null) {
          effEl.textContent = '—';
          effEl.style.color = '#9ca3af';
        } else {
          const eff = price * (1 - disc / 100);
          effEl.textContent = fmt(eff);
          effEl.style.color = '';
        }
      }

      const changed = (price !== origPrice) || (disc !== origDisc);
      if (changed) {
        priceListDirty.add(itemId);
        tr.style.background = '#fef3c7';
      } else {
        priceListDirty.delete(itemId);
        tr.style.background = '';
      }

      if (saveOneBtn) saveOneBtn.disabled = !changed;
      updatePriceListSaveBtn();
    };

    priceEl?.addEventListener('input', recompute);
    discEl?.addEventListener('input', recompute);

    saveOneBtn?.addEventListener('click', () => savePriceListHandler('single', itemId));

    histBtn?.addEventListener('click', () => {
      priceListHistFilter.itemId = itemId;
      const skuTxt = row.sku || '';
      const nameTxt = row.item_name || '';
      const infoEl = document.getElementById('plHistFilterInfo');
      if (infoEl) {
        infoEl.style.display = 'block';
        infoEl.innerHTML = `Filter aktif: <b>${esc(skuTxt)} — ${esc(nameTxt)}</b>`;
      }
      const resetBtn = document.getElementById('plHistResetBtn');
      if (resetBtn) resetBtn.style.display = 'inline-block';
      reloadPriceListHistory();
    });

    delBtn?.addEventListener('click', () => deletePriceListItemHandler(itemId, row.sku));
  });
}

function collectPriceListChanges(itemIdOnly = null) {
  const result = [];
  for (const itemId of priceListDirty) {
    if (itemIdOnly != null && itemId !== itemIdOnly) continue;

    const tr = document.querySelector(`#tbody-price-list tr[data-item-id="${itemId}"]`);
    if (!tr) continue;
    const priceEl = tr.querySelector('.pl-price');
    const discEl  = tr.querySelector('.pl-disc');
    if (!priceEl) continue;

    const priceRaw = priceEl.value;
    const discRaw  = discEl?.value ?? '0';
    const row = priceListRowsCache.find(x => Number(x.item_id) === itemId);
    const label = row ? `${row.sku} — ${row.item_name}` : `#${itemId}`;

    // Harga kosong TIDAK boleh diam-diam disimpan sebagai 0.
    // Untuk menghapus harga, pakai tombol "Hapus" di baris tersebut.
    if (String(priceRaw).trim() === '') {
      toast(`Harga ${label} masih kosong — isi harga, atau pakai tombol Hapus`, true);
      return null;
    }

    const price = Number(priceRaw);
    const disc  = String(discRaw).trim() === '' ? 0 : Number(discRaw);

    if (isNaN(price) || price < 0) {
      toast(`Harga tidak valid untuk ${label}`, true);
      return null;
    }
    if (isNaN(disc) || disc < 0 || disc > 100) {
      toast(`Diskon harus 0–100 untuk ${label}`, true);
      return null;
    }

    result.push({ item_id: itemId, price, discount_pct: disc });
  }
  return result;
}

async function savePriceListHandler(mode = 'bulk', itemIdOnly = null) {
  if (!perms.priceListManage) { toast('Tidak ada akses ubah harga', true); return; }

  // Selalu kirim SEMUA baris yang berubah. Dulu tombol "Simpan" per baris hanya
  // mengirim baris itu, lalu reload setelah simpan membuang perubahan baris lain
  // tanpa peringatan (data hilang diam-diam).
  const lines = collectPriceListChanges(null);
  if (lines === null) return;
  if (!lines.length) { toast('Tidak ada perubahan', true); return; }

  if (mode === 'bulk' && lines.length > 20) {
    if (!confirm(`Simpan ${lines.length} perubahan harga?`)) return;
  }

  const reason = document.getElementById('plReason')?.value.trim() || null;
  const bulkBtn = document.getElementById('plSaveBtn');
  const singleBtn = itemIdOnly != null
    ? document.querySelector(`#tbody-price-list tr[data-item-id="${itemIdOnly}"] .pl-save-one`)
    : null;

  const activeBtn = mode === 'single' ? singleBtn : bulkBtn;
  const origText = activeBtn?.textContent;
  if (activeBtn) { activeBtn.disabled = true; activeBtn.textContent = 'Menyimpan...'; }

  try {
    const { data, error } = await supabase.rpc('save_price_list', {
      p_lines: lines,
      p_reason: reason
    });
    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    const savedCount = Number(row?.saved_count ?? lines.length);
    const changedCount = Number(row?.changed_count ?? 0);

    toast(`✓ Tersimpan: ${savedCount} baris (${changedCount} berubah)`);

    const reasonEl = document.getElementById('plReason');
    if (reasonEl) reasonEl.value = '';

    if (mode === 'single' && itemIdOnly != null) {
      priceListDirty.delete(itemIdOnly);
      updatePriceListSaveBtn();
    } else {
      priceListDirty.clear();
      updatePriceListSaveBtn();
    }

    await Promise.all([reloadPriceList(), reloadPriceListHistory()]);
  } catch (err) {
    toast('Gagal simpan: ' + (err.message || err), true);
  } finally {
    if (activeBtn) {
      activeBtn.disabled = false;
      activeBtn.textContent = origText || (mode === 'single' ? 'Simpan' : 'Simpan Perubahan');
    }
    updatePriceListSaveBtn();
  }
}

async function deletePriceListItemHandler(itemId, sku) {
  if (!perms.priceListManage) { toast('Tidak ada akses hapus', true); return; }
  const ok = confirm(
    `Hapus harga untuk item ${sku || itemId}?\n\n` +
    `Setelah dihapus, item ini TIDAK BISA dijual sampai harga diisi kembali (D7).\n` +
    `Riwayat perubahan tetap tersimpan.`
  );
  if (!ok) return;

  try {
    const { data, error } = await supabase.rpc('delete_price_list_item', { p_item_id: itemId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (row?.deleted) {
      toast('✓ Harga item dihapus');
    } else {
      toast('Item tidak ditemukan atau sudah tanpa harga', true);
    }
    priceListDirty.delete(itemId);
    await Promise.all([reloadPriceList(), reloadPriceListHistory()]);
  } catch (err) {
    toast('Gagal hapus: ' + (err.message || err), true);
  }
}

function wirePriceListHistory() {
  const searchEl = document.getElementById('plHistSearch');
  const resetBtn = document.getElementById('plHistResetBtn');
  const moreBtn  = document.getElementById('plHistMoreBtn');

  if (searchEl) {
    let t = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        priceListHistFilter.search = searchEl.value.trim();
        await reloadPriceListHistory();
      }, 300);
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      priceListHistFilter.itemId = null;
      priceListHistFilter.search = '';
      const searchField = document.getElementById('plHistSearch');
      if (searchField) searchField.value = '';
      const infoEl = document.getElementById('plHistFilterInfo');
      if (infoEl) { infoEl.style.display = 'none'; infoEl.innerHTML = ''; }
      resetBtn.style.display = 'none';
      await reloadPriceListHistory();
    });
  }

  if (moreBtn) moreBtn.addEventListener('click', () => loadPriceListHistory(true));
}

async function reloadPriceListHistory() {
  priceListHistOffset = 0;
  const tbody = document.getElementById('tbody-price-list-history');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  const moreBtn = document.getElementById('plHistMoreBtn');
  if (moreBtn) moreBtn.style.display = 'none';
  const info = document.getElementById('plHistInfo');
  if (info) info.textContent = '';
  await loadPriceListHistory(false);
}

async function loadPriceListHistory(append = false) {
  const tbody = document.getElementById('tbody-price-list-history');
  if (!tbody) return;
  if (!append) tbody.innerHTML = '';
  const seq = ++priceListHistReqSeq;

  try {
    const { data, error } = await supabase.rpc('list_price_list_history', {
      p_item_id: priceListHistFilter.itemId ?? null,
      p_limit:   PRICE_LIST_HIST_LIMIT,
      p_offset:  priceListHistOffset
    });
    if (error) throw error;
    if (seq !== priceListHistReqSeq) return;

    const rows = data || [];
    const totalCount = rows[0]?.total_count != null ? Number(rows[0].total_count) : rows.length;

    if (!append && !rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Belum ada riwayat perubahan</td></tr>';
      if (priceListHistFilter.itemId != null) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Belum ada riwayat untuk item ini</td></tr>';
      }
      return;
    }

    let filtered = rows;
    if (priceListHistFilter.search) {
      const q = priceListHistFilter.search.toLowerCase();
      filtered = rows.filter(r =>
        String(r.sku || '').toLowerCase().includes(q) ||
        String(r.item_name || '').toLowerCase().includes(q)
      );
    }

    const html = filtered.map(r => {
      const oldPrice = r.old_price == null ? '—' : fmt(r.old_price);
      const newPrice = r.new_price == null ? '—' : fmt(r.new_price);
      const oldDisc  = r.old_discount == null ? '—' : fmt(r.old_discount);
      const newDisc  = r.new_discount == null ? '—' : fmt(r.new_discount);
      return `
        <tr>
          <td data-label="Waktu" style="white-space:nowrap;">${esc(fmtDateTime(r.changed_at))}</td>
          <td data-label="SKU">${esc(r.sku)}</td>
          <td data-label="Nama">${esc(r.item_name)}</td>
          <td data-label="Harga" class="num">${oldPrice} → <b>${newPrice}</b></td>
          <td data-label="Diskon" class="num">${oldDisc}% → <b>${newDisc}%</b></td>
          <td data-label="Oleh">${esc(r.changed_by_name || '—')}</td>
          <td data-label="Alasan">${esc(r.reason || '—')}</td>
        </tr>`;
    }).join('');

    if (append) tbody.insertAdjacentHTML('beforeend', html);
    else tbody.innerHTML = html || '<tr><td colspan="7" style="text-align:center;color:#9ca3af;">Tidak ada hasil cocok</td></tr>';

    priceListHistOffset += rows.length;
    const info = document.getElementById('plHistInfo');
    if (info) info.textContent = `Menampilkan ${Math.min(priceListHistOffset, totalCount)} dari ${totalCount}`;
    const moreBtn = document.getElementById('plHistMoreBtn');
    if (moreBtn) moreBtn.style.display = priceListHistOffset < totalCount ? 'inline-block' : 'none';
  } catch (err) {
    tbody.innerHTML += `<tr><td colspan="7" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

async function printPriceListForm() {
  if (!priceListRowsCache.length) {
    toast('Tidak ada data untuk dicetak', true);
    return;
  }

  // Memuat semua halaman = me-render ulang tabel, jadi perubahan yang belum
  // disimpan akan hilang. Minta simpan dulu.
  if (priceListDirty.size > 0) {
    toast('Simpan dulu perubahan harga yang belum tersimpan sebelum mencetak', true);
    return;
  }

  // Muat semua halaman dulu. Tanpa ini, cetakan hanya memuat PRICE_LIST_LIMIT
  // baris pertama dan item sisanya hilang dari form harga resmi.
  if (priceListOffset < priceListTotalCount) {
    let guard = 0;
    while (priceListOffset < priceListTotalCount && guard < 100) {
      const before = priceListOffset;
      await loadPriceList(true);
      if (priceListOffset === before) break; // gagal memuat -> berhenti, jangan loop
      guard += 1;
    }
    if (priceListOffset < priceListTotalCount) {
      toast(`Gagal memuat semua item (${priceListOffset} dari ${priceListTotalCount}). Cetakan dibatalkan.`, true);
      return;
    }
  }

  const shortName = (s, max = 40) => {
    const str = String(s || '');
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
  };

  const filterInfo = [];
  if (priceListFilter.search) filterInfo.push(`Cari: "${priceListFilter.search}"`);
  if (priceListFilter.onlyWithPrice) filterInfo.push('Hanya yang sudah ada harga');

  const rowsHtml = priceListRowsCache.map((r, idx) => {
    const hasPrice = r.has_price === true;
    const price = hasPrice ? fmt(r.price) : '';
    const disc  = hasPrice ? fmt(r.discount_pct) : '';
    const eff   = hasPrice ? fmt(r.effective_price) : '';
    const fullName = r.item_name || '';
    return `
      <tr>
        <td class="c">${idx + 1}</td>
        <td class="sku">${esc(r.sku)}</td>
        <td title="${esc(fullName)}">${esc(shortName(fullName))}</td>
        <td class="c">${esc(r.unit)}</td>
        <td class="r">${price}</td>
        <td class="r">${disc}</td>
        <td class="r">${eff}</td>
        <td class="new"></td>
        <td class="memo"></td>
      </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="id"><head><meta charset="UTF-8">
<title>Daftar Harga</title>
<style>
  @page { size: A4 portrait; margin: 10mm 8mm; }
  html, body { margin: 0; padding: 0; background: #f3f4f6; }
  * { box-sizing: border-box; }
  .sheet { width: 210mm; min-height: 297mm; margin: 12px auto; padding: 10mm 8mm; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.15); font-family: Arial, Helvetica, sans-serif; font-size: 9px; color: #000; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px; }
  .head h1 { font-size: 13px; margin: 0 0 3px; letter-spacing: .3px; }
  .head .meta { font-size: 9px; line-height: 1.4; }
  .head .meta b { display: inline-block; min-width: 52px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { border: 1px solid #000; padding: 2px 3px; vertical-align: top; font-size: 8.5px; }
  th { background: #eee; font-weight: 700; font-size: 8.5px; }
  td.c { text-align: center; } td.r { text-align: right; }
  td.sku { font-family: "Courier New", monospace; font-size: 8px; word-break: break-all; }
  td.memo { font-size: 8px; } td.new { background: #fff; }
  thead { display: table-header-group; } tr { page-break-inside: avoid; }
  .legend { margin-top: 6px; font-size: 8.5px; }
  .sign { display: flex; justify-content: space-between; margin-top: 24px; page-break-inside: avoid; }
  .sign div { text-align: center; width: 40%; font-size: 9px; }
  .sign .line { margin-top: 40px; border-top: 1px solid #000; padding-top: 3px; }
  .actions { position: fixed; top: 8px; right: 8px; z-index: 10; }
  .actions button { padding: 6px 12px; font-size: 13px; cursor: pointer; }
  @media print { html, body { background: #fff; } .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; } .actions { display: none; } }
</style></head>
<body>
  <div class="actions"><button onclick="window.print()">🖨️ Cetak</button></div>
  <div class="sheet">
  <div class="head">
    <div>
      <h1>DAFTAR HARGA</h1>
      <div class="meta">
        <div><b>Tanggal</b> ${esc(new Date().toLocaleDateString('id-ID'))}</div>
        ${filterInfo.length ? `<div><b>Filter</b> ${esc(filterInfo.join(' · '))}</div>` : ''}
      </div>
    </div>
    <div class="meta" style="text-align:right;">
      <div>Total item: <b>${priceListRowsCache.length}</b></div>
      <div>Dicetak: ${new Date().toLocaleString('id-ID')}</div>
    </div>
  </div>
  <table>
    <colgroup>
      <col style="width:24px;"><col style="width:70px;"><col><col style="width:36px;">
      <col style="width:64px;"><col style="width:44px;"><col style="width:64px;">
      <col style="width:64px;"><col style="width:80px;">
    </colgroup>
    <thead>
      <tr>
        <th>No</th><th>SKU</th><th>Nama</th><th>Sat.</th>
        <th>Harga<br>Sekarang</th><th>Diskon<br>%</th><th>Harga<br>Efektif</th>
        <th>Harga Baru</th><th>Memo</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="legend">Harga belum termasuk PPN. Kolom <b>Harga Baru</b> &amp; <b>Memo</b> diisi manual saat rapat penyesuaian harga.</div>
  <div class="sign">
    <div><div>Disiapkan oleh</div><div class="line">(____________________)</div></div>
    <div><div>Disetujui oleh</div><div class="line">(____________________)</div></div>
  </div>
  </div><!-- /.sheet -->
</body></html>`;

  const w = window.open('', '_blank');
  if (!w) { toast('Popup diblokir browser. Izinkan popup untuk mencetak.', true); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

// ============================================================
// UNITS
// ============================================================
async function loadUnitsAndFillDropdown() {
  try {
    allUnits = await listUnits();
    fillUnitDropdowns();
  } catch (err) {
    console.error('loadUnitsAndFillDropdown:', err);
    toast('Gagal memuat daftar satuan: ' + (err.message || err), true);
  }
}

function fillUnitDropdowns() {
  const sel = document.getElementById('newItemUnit');
  if (sel) {
    const current = sel.value;
    sel.innerHTML = '<option value="">— pilih satuan —</option>' +
      allUnits.map(u =>
        `<option value="${esc(u.name)}">${esc(u.name)}</option>`
      ).join('');
    if (current) sel.value = current;
  }
}

function wireUnitsModal() {
  const modal = document.getElementById('unitsModal');
  const openBtn = document.getElementById('manageUnitsBtn');
  const closeBtn = document.getElementById('closeUnitsModalBtn');
  const addBtn = document.getElementById('addUnitBtn');
  if (!modal || !openBtn) return;

  openBtn.addEventListener('click', async () => {
    modal.style.display = 'flex';
    await renderUnitsList();
  });
  closeBtn?.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });

  addBtn?.addEventListener('click', async () => {
    const codeEl = document.getElementById('newUnitCode');
    const nameEl = document.getElementById('newUnitName');
    const sortEl = document.getElementById('newUnitSort');
    const code = codeEl.value.trim();
    const name = nameEl.value.trim();
    if (!code || !name) { toast('Kode dan nama wajib diisi', true); return; }

    addBtn.disabled = true;
    addBtn.textContent = 'Menyimpan...';
    try {
      await createUnit({ code, name, sort_order: Number(sortEl.value) || 100 });
      toast('✓ Unit ditambahkan');
      codeEl.value = '';
      nameEl.value = '';
      sortEl.value = '100';
      await loadUnitsAndFillDropdown();
      await renderUnitsList();
    } catch (err) {
      toast('Gagal: ' + (err.message || err), true);
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = '+ Tambah';
    }
  });
}

async function renderUnitsList() {
  const wrap = document.getElementById('unitsList');
  if (!wrap) return;
  wrap.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:12px;">Memuat...</div>';
  try {
    const rows = await listUnits({ includeInactive: true });
    if (!rows.length) {
      wrap.innerHTML = '<div style="color:#9ca3af;text-align:center;padding:12px;">Belum ada unit.</div>';
      return;
    }

    wrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid #e5e7eb;">
            <th style="padding:6px 4px;text-align:left;font-size:11px;color:#6b7280;">Kode</th>
            <th style="padding:6px 4px;text-align:left;font-size:11px;color:#6b7280;">Nama</th>
            <th style="padding:6px 4px;text-align:right;font-size:11px;color:#6b7280;">Urutan</th>
            <th style="padding:6px 4px;text-align:center;font-size:11px;color:#6b7280;">Status</th>
            <th style="padding:6px 4px;text-align:right;font-size:11px;color:#6b7280;">Aksi</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(u => `
            <tr data-unit-id="${u.id}" style="border-bottom:1px solid #f3f4f6;${u.is_active ? '' : 'opacity:.55;'}">
              <td data-label="Kode" style="padding:6px 4px;font-family:'Courier New',monospace;font-size:12px;">${esc(u.code)}</td>
              <td data-label="Nama" style="padding:6px 4px;">
                <input type="text" class="unit-name-input" value="${esc(u.name)}" maxlength="80"
                       style="width:100%;padding:4px 6px;border:1px solid #d0d5dd;border-radius:5px;font-size:13px;">
              </td>
              <td data-label="Urutan" style="padding:6px 4px;text-align:right;">
                <input type="number" class="unit-sort-input" value="${u.sort_order || 0}"
                       style="width:70px;padding:4px 6px;border:1px solid #d0d5dd;border-radius:5px;font-size:13px;text-align:right;">
              </td>
              <td data-label="Status" style="padding:6px 4px;text-align:center;font-size:12px;">
                ${u.is_active
                  ? '<span style="background:#d1fae5;color:#065f46;padding:2px 6px;border-radius:4px;font-weight:600;">Aktif</span>'
                  : '<span style="background:#e5e7eb;color:#6b7280;padding:2px 6px;border-radius:4px;font-weight:600;">Nonaktif</span>'}
              </td>
              <td data-label="Aksi" style="padding:6px 4px;text-align:right;white-space:nowrap;">
                <button type="button" class="btn btn-primary unit-save-btn"
                        style="padding:4px 10px;font-size:12px;">Simpan</button>
                ${u.is_active
                  ? `<button type="button" class="btn btn-danger unit-delete-btn"
                            style="padding:4px 10px;font-size:12px;margin-left:4px;">Nonaktif</button>`
                  : `<button type="button" class="btn btn-secondary unit-reactivate-btn"
                            style="padding:4px 10px;font-size:12px;margin-left:4px;">Aktifkan</button>`}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    wrap.querySelectorAll('[data-unit-id]').forEach(tr => {
      const id = Number(tr.dataset.unitId);
      tr.querySelector('.unit-save-btn')?.addEventListener('click', async () => {
        const name = tr.querySelector('.unit-name-input').value.trim();
        const sort = Number(tr.querySelector('.unit-sort-input').value) || 0;
        try {
          await updateUnit(id, { name, sort_order: sort });
          toast('✓ Unit diupdate');
          await loadUnitsAndFillDropdown();
          await renderUnitsList();
        } catch (err) {
          toast('Gagal: ' + (err.message || err), true);
        }
      });
      tr.querySelector('.unit-delete-btn')?.addEventListener('click', async () => {
        if (!confirm('Nonaktifkan unit ini? Unit tidak muncul di dropdown, tapi data lama tetap valid.')) return;
        try {
          await deleteUnit(id);
          toast('✓ Unit dinonaktifkan');
          await loadUnitsAndFillDropdown();
          await renderUnitsList();
        } catch (err) {
          toast('Gagal: ' + (err.message || err), true);
        }
      });
      tr.querySelector('.unit-reactivate-btn')?.addEventListener('click', async () => {
        try {
          await reactivateUnit(id);
          toast('✓ Unit diaktifkan');
          await loadUnitsAndFillDropdown();
          await renderUnitsList();
        } catch (err) {
          toast('Gagal: ' + (err.message || err), true);
        }
      });
    });
  } catch (err) {
    wrap.innerHTML = `<div style="color:#b91c1c;text-align:center;padding:12px;">${esc(err.message)}</div>`;
  }
}