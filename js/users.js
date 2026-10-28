// js/users.js
import { supabase } from './supabase-client.js';

export async function listUsers() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, is_active, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function createUser({ username, password, full_name, role }) {
  const { data, error } = await supabase.rpc('admin_create_user', {
    p_username: username,
    p_password: password,
    p_full_name: full_name,
    p_role: role
  });
  if (error) throw error;
  return data; // uuid
}

export async function updateUser(userId, { full_name, role, is_active }) {
  const { error } = await supabase.rpc('admin_update_user', {
    p_user_id: userId,
    p_full_name: full_name,
    p_role: role,
    p_is_active: is_active
  });
  if (error) throw error;
}

export async function deleteUser(userId) {
  const { error } = await supabase.rpc('admin_delete_user', { p_user_id: userId });
  if (error) throw error;
}

// Daftar role yang bisa dipilih saat buat/edit user
export const AVAILABLE_ROLES = [
  { value: 'viewer',     label: 'Viewer (read-only)' },
  { value: 'sales',      label: 'Sales' },
  { value: 'kasir',      label: 'Kasir' },
  { value: 'gudang',     label: 'Gudang' },
  { value: 'finance',    label: 'Finance' },
  { value: 'supervisor', label: 'Supervisor' },
  { value: 'admin',      label: 'Admin' },
  { value: 'superadmin', label: 'Superadmin' }
];