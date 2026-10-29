// js/permissions.js
import { supabase } from './supabase-client.js';

let cache = {}; // cache per key selama sesi

export async function hasPermission(key) {
  if (key in cache) return cache[key];
  const { data, error } = await supabase.rpc('has_permission', { p_key: key });
  if (error) {
    console.warn('has_permission error:', key, error.message);
    return false;
  }
  cache[key] = data === true;
  return cache[key];
}

export async function hasAnyPermission(keys) {
  for (const k of keys) {
    if (await hasPermission(k)) return true;
  }
  return false;
}

export async function hasAllPermissions(keys) {
  for (const k of keys) {
    if (!(await hasPermission(k))) return false;
  }
  return true;
}

// Untuk halaman yang butuh cek permission saat load
export async function requirePermission(key, fallbackUrl = './dashboard.html') {
  const ok = await hasPermission(key);
  if (!ok) {
    window.location.href = fallbackUrl;
    return false;
  }
  return true;
}

// Kelola permission
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
      .from('role_permissions')
      .insert({ role, permission });
    if (error && error.code !== '23505') throw error; // ignore duplicate
  } else {
    const { error } = await supabase
      .from('role_permissions')
      .delete().eq('role', role).eq('permission', permission);
    if (error) throw error;
  }
  // Reset cache lokal agar hasPermission berikutnya re-query
  cache = {};
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
    // Hapus override (kembali ke default role)
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
  cache = {};
}

// Reset cache (dipanggil saat logout atau role berubah)
export function resetPermissionCache() {
  cache = {};
}