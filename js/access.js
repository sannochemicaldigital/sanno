// js/access.js
import { getCurrentRole } from './auth.js';
import { supabase } from './supabase-client.js';

let cache = null;

// ============================================================
// AMBIL MAP AKSES (cache sekali per sesi)
// ============================================================
export async function getAccessMap() {
  if (cache) return cache;
  const { data, error } = await supabase.from('page_access').select('page, role');
  if (error) throw error;
  const map = {};
  (data || []).forEach(r => {
    map[r.page] = map[r.page] || new Set();
    map[r.page].add(r.role);
  });
  cache = map;
  return map;
}

// ============================================================
// CEK AKSES
// ============================================================
export async function canAccess(page, role = null) {
  const r = role || await getCurrentRole();
  if (!r) return false;
  const map = await getAccessMap();
  return map[page]?.has(r) === true;
}

// ============================================================
// GUARD: redirect kalau tidak berhak
// ============================================================
export async function requirePageAccess(pageName) {
  const role = await getCurrentRole();
  if (!role) {
    window.location.href = './index.html';
    return null;
  }
  const allowed = await canAccess(pageName, role);
  if (!allowed) {
    const fallback = await defaultPageFor(role);
    if (fallback && fallback !== pageName) {
      window.location.href = `./${fallback}.html`;
    } else {
      window.location.href = './dashboard.html';
    }
    return null;
  }
  return role;
}

// Halaman default per role (untuk redirect saat tidak berhak)
async function defaultPageFor(role) {
  if (role === 'sales')  return 'sales-order';
  if (role === 'kasir')  return 'dashboard';   // belum ada kasir.html
  if (role === 'gudang') return 'inventory';
  return 'dashboard';
}

// ============================================================
// RENDER NAVIGASI sesuai role
// ============================================================
export async function renderNav(navEl, activePage = null) {
  const role = await getCurrentRole();
  if (!role) return;

  const items = [
    { page: 'dashboard',   href: './dashboard.html',  label: 'Dashboard' },
    { page: 'sales-order', href: './sales-order.html', label: 'Sales Order' },
    { page: 'approval',    href: './approval.html',   label: 'Approval' },
    { page: 'inventory',   href: './inventory.html',  label: 'Inventory' },
    { page: 'kasir',       href: './kasir.html',      label: 'Kasir' },
    { page: 'delivery',    href: './delivery.html',   label: 'Delivery' },
    { page: 'master',      href: './master.html',     label: 'Master' },
    { page: 'journal',     href: './journal.html',    label: 'Jurnal' },
    { page: 'reports',     href: './reports.html',    label: 'Laporan' },
    { page: 'settings',    href: './settings.html',   label: 'Pengaturan' }
  ];

  const allowedItems = [];
  for (const item of items) {
    if (await canAccess(item.page, role)) allowedItems.push(item);
  }

  navEl.innerHTML = allowedItems.map(it =>
    `<a href="${it.href}" class="${it.page === activePage ? 'active' : ''}">${it.label}</a>`
  ).join('');
}