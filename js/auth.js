// js/auth.js
import { supabase } from './supabase-client.js';

export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password: password.trim()
  });
  if (error) throw error;
  return data.user;
}

export async function logout() {
  await supabase.auth.signOut();
  window.location.href = './index.html';
}

export async function currentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function currentProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('profiles').select('*').eq('id', user.id).single();
  if (error) throw error;
  return data;
}

// Guard: panggil di halaman yang butuh login (mis. dashboard.html)
export async function requireAuth() {
  const user = await currentUser();
  if (!user) {
    window.location.href = './index.html';
    return null;
  }
  return user;
}

// Urutan hierarki role
// viewer < sales/kasir/gudang < finance < supervisor < admin < superadmin
const ROLE_LEVEL = {
  viewer:     1,
  sales:      2,
  kasir:      2,
  gudang:     2,
  finance:    3,
  supervisor: 4,
  admin:      5,
  superadmin: 6
};

export async function getCurrentRole() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', session.user.id)
    .single();
  if (error) return null;
  return data?.role ?? null;
}

export async function hasRole(minRole) {
  const role = await getCurrentRole();
  if (!role) return false;
  return (ROLE_LEVEL[role] || 0) >= (ROLE_LEVEL[minRole] || 0);
}

// Helper spesifik
export async function isSales()       { return (await getCurrentRole()) === 'sales'; }
export async function isKasir()       { return (await getCurrentRole()) === 'kasir'; }
export async function isGudang()      { return (await getCurrentRole()) === 'gudang'; }
export async function isFinance()     { return (await getCurrentRole()) === 'finance'; }
export async function isSupervisor()  { return (await getCurrentRole()) === 'supervisor'; }
export async function isAdmin()       { return await hasRole('admin'); }
export async function isSuperAdmin()  { return (await getCurrentRole()) === 'superadmin'; }

// Cek akses spesifik
export async function canApproveSO() {
  const role = await getCurrentRole();
  if (!role) return false;
  const mode = await getSetting('so_approval_mode');
  if (mode === 'finance_and_supervisor') {
    return ['finance','supervisor','admin','superadmin'].includes(role);
  }
  return ['supervisor','admin','superadmin'].includes(role);
}

export async function canMarkDelivered() {
  const role = await getCurrentRole();
  return ['gudang','admin','superadmin'].includes(role);
}

export async function canCreateCashSale() {
  const role = await getCurrentRole();
  return ['kasir','admin','superadmin'].includes(role);
}

export async function canVoidSO() {
  const role = await getCurrentRole();
  return ['supervisor','admin','superadmin'].includes(role);
}

// Ambil setting dari app_settings
export async function getSetting(key) {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .single();
  if (error) return null;
  return data?.value ?? null;
}