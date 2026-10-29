// js/access.js
import { getCurrentRole } from './auth.js';
import { supabase } from './supabase-client.js';
import { hasPermission } from './permissions.js';

let cache = null;

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

export async function canAccess(page, role = null) {
  const r = role || await getCurrentRole();
  if (!r) return false;
  const map = await getAccessMap();
  return map[page]?.has(r) === true;
}

export async function requirePageAccess(pageName) {
  const role = await getCurrentRole();
  if (!role) {
    window.location.href = './index.html';
    return null;
  }
  const allowed = await canAccess(pageName, role);
  if (!allowed) {
    const fallback = await defaultPageFor(role);
    window.location.href = fallback && fallback !== pageName
      ? `./${fallback}.html`
      : './dashboard.html';
    return null;
  }
  return role;
}

async function defaultPageFor(role) {
  if (role === 'sales')  return 'sales-order';
  if (role === 'kasir')  return 'kasir';
  if (role === 'gudang') return 'inventory';
  return 'dashboard';
}

// Menu dengan cek page_access + permission
export async function renderNav(navEl, activePage = null) {
  const role = await getCurrentRole();
  if (!role) return;

  const menuDefs = [
    { page: 'dashboard',   href: './dashboard.html',   label: 'Dashboard',
      perm: 'dashboard.view' },
    { page: 'sales-order', href: './sales-order.html', label: 'Sales Order',
      perm: 'sales.order.view' },
    { page: 'approval',    href: './approval.html',    label: 'Approval',
      perm: 'sales.order.approve' },
    { page: 'delivery',    href: './delivery.html',    label: 'Delivery',
      perm: 'delivery.view' },
    { page: 'inventory',   href: './inventory.html',   label: 'Inventory',
      perm: 'inventory.view' },
    { page: 'kasir',       href: './kasir.html',       label: 'Kasir',
      perm: 'kasir.view' },
    { page: 'master',      href: './master.html',      label: 'Master',
      perm: 'master.accounts.view' },
    { page: 'journal',     href: './journal.html',     label: 'Jurnal',
      perm: 'finance.journal.view' },
    { page: 'reports',     href: './reports.html',     label: 'Laporan',
      perm: 'reports.view' },
    { page: 'settings',    href: './settings.html',    label: 'Pengaturan',
      perm: 'admin.settings.view' }
  ];

  const allowed = [];
  for (const m of menuDefs) {
    const pageOk = await canAccess(m.page, role);
    const permOk = m.perm ? await hasPermission(m.perm) : true;
    if (pageOk && permOk) allowed.push(m);
  }

  navEl.innerHTML = allowed.map(m =>
    `<a href="${m.href}" class="${m.page === activePage ? 'active' : ''}">${m.label}</a>`
  ).join('');
}