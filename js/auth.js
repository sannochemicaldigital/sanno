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

// Cek apakah user yang login ber-role admin
export async function isAdmin() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return false;
  const { data, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', session.user.id)
    .single();
  if (error) return false;
  return data?.role === 'admin';
}