// js/auth.js
import { supabase } from './supabase-client.js';

// ============================================================
// CACHE ROLE
// ============================================================
let roleCache = null;
let roleLoading = null;

export async function getCurrentRole() {
  if (roleCache) return roleCache;
  if (roleLoading) return roleLoading;

  roleLoading = (async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return null;

      // 1. Coba baca dari JWT (app_metadata.role) — 0ms
      let role = session.user.app_metadata?.role || null;

      // 2. Fallback: query DB sekali kalau JWT belum punya role
      if (!role) {
        const { data, error } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', session.user.id)
          .single();
        if (!error) role = data?.role ?? null;
      }

      roleCache = role;
      return roleCache;
    } finally {
      roleLoading = null;
    }
  })();

  return roleLoading;
}

export function resetRoleCache() {
  roleCache = null;
  roleLoading = null;
}

// ============================================================
// AUTH
// ============================================================
export async function login(email, password) {
  let em = String(email || '').trim().toLowerCase();
  if (em && !em.includes('@')) em = em + '@sanno.local';

  const { data, error } = await supabase.auth.signInWithPassword({
    email: em,
    password: String(password || '').trim()
  });
  if (error) throw error;

  resetRoleCache();
  return data.user;
}

export async function logout() {
  resetRoleCache();
  await supabase.auth.signOut();
  window.location.href = './index.html';
}

export async function currentUser() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user ?? null;
}

export async function currentProfile() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', session.user.id)
    .single();
  if (error) throw error;
  return data;
}

export async function requireAuth() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = './index.html';
    return null;
  }
  return session.user;
}

// ============================================================
// ROLE HELPERS
// ============================================================
const ROLE_LEVEL = {
  viewer: 1,
  sales: 2, kasir: 2, gudang: 2,
  finance: 3,
  supervisor: 4,
  admin: 5,
  superadmin: 6
};

export async function hasRole(minRole) {
  const role = await getCurrentRole();
  if (!role) return false;
  return (ROLE_LEVEL[role] || 0) >= (ROLE_LEVEL[minRole] || 0);
}

export async function isAdmin()      { return await hasRole('admin'); }
export async function isSuperAdmin() { return (await getCurrentRole()) === 'superadmin'; }
export async function isSales()      { return (await getCurrentRole()) === 'sales'; }
export async function isKasir()      { return (await getCurrentRole()) === 'kasir'; }
export async function isGudang()     { return (await getCurrentRole()) === 'gudang'; }
export async function isFinance()    { return (await getCurrentRole()) === 'finance'; }
export async function isSupervisor() { return (await getCurrentRole()) === 'supervisor'; }

// ============================================================
// SETTINGS
// ============================================================
export async function getSetting(key) {
  const { data, error } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', key)
    .single();
  if (error) return null;
  return data?.value ?? null;
}