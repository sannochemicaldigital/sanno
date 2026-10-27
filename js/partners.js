// js/partners.js
import { supabase } from './supabase-client.js';

export async function listPartners(type = null) {
  let q = supabase.from('partners').select('*').eq('is_active', true).order('name');
  if (type) q = q.eq('type', type);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function createPartner(p) {
  const { data, error } = await supabase.from('partners').insert(p).select().single();
  if (error) throw error;
  return data;
}