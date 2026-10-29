// js/permissions.js
import { supabase } from './supabase-client.js';

let cacheSet = null;   // Set of granted permission keys
let loading = null;    // Promise loading (untuk dedupe concurrent)

async function loadPermissions() {
  if (cacheSet) return cacheSet;
  if (loading) return loading;

  loading = (async () => {
    const { data, error } = await supabase.rpc('get_my_permissions');
    if (error) {
      console.warn('get_my_permissions error:', error.message);
      cacheSet = new Set();
      loading = null;
      return cacheSet;
    }
    cacheSet = new Set((data || []).map(r => r.permission));
    loading = null;
    return cacheSet;
  })();

  return loading;
}

export async function hasPermission(key) {
  const set = await loadPermissions();
  return set.has(key);
}

export async function hasAnyPermission(keys) {
  const set = await loadPermissions();
  return keys.some(k => set.has(k));
}

export async function hasAllPermissions(keys) {
  const set = await loadPermissions();
  return keys.every(k => set.has(k));
}

export async function requirePermission(key, fallbackUrl = './dashboard.html') {
  if (!(await hasPermission(key))) {
    window.location.href = fallbackUrl;
    return false;
  }
  return true;
}

// Preload permission sekali di awal (dipanggil di halaman yang butuh cepat)
export async function preloadPermissions() {
  return loadPermissions();
}

// Reset cache (setelah ubah permission atau logout)
export function resetPermissionCache() {
  cacheSet = null;
  loading = null;
}

// Kelola permission (untuk halaman settings)
export async function listPermissions() {
  const { data, error } = await supabase
    .from('permissions')
    .select('key, category, label, description, sort_order')
    .order('category').order('sort_order');
  if (error) throw error;
  return data;
}

export async function listRolePermissions() {
  const { data, error } = await supabase
    .from('role_permissions').select('role, permission');
  if (error) throw error;
  return data;
}

export async function setRolePermission(role, permission, granted) {
  if (granted) {
    const { error } = await supabase
      .from('role_permissions').insert({ role, permission });
    if (error && error.code !== '23505') throw error;
  } else {
    const { error } = await supabase
      .from('role_permissions')
      .delete().eq('role', role).eq('permission', permission);
    if (error) throw error;
  }
  resetPermissionCache();
}

export async function listUserPermissions(userId) {
  const { data, error } = await supabase
    .from('user_permissions')
    .select('permission, granted')
    .eq('user_id', userId);
  if (error) throw error;
  return data;
}

export async function setUserPermission(userId, permission, granted) {
  if (granted === null) {
    const { error } = await supabase
      .from('user_permissions')
      .delete().eq('user_id', userId).eq('permission', permission);
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from('user_permissions')
      .upsert({
        user_id: userId,
        permission,
        granted,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,permission' });
    if (error) throw error;
  }
  resetPermissionCache();
}