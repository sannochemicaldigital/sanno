// js/profiles.js
import { supabase } from './supabase-client.js';

export async function listProfiles() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, full_name, role, is_active, created_at')
    .order('email');
  if (error) throw error;
  return data;
}

export async function updateProfile(id, patch) {
  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}