// js/items.js
import { supabase } from './supabase-client.js';

export async function listItems() {
  const { data, error } = await supabase
    .from('items').select('*').eq('is_active', true).order('sku');
  if (error) throw error;
  return data;
}

export async function createItem({ sku, name, unit = 'pcs', min_stock = 0 }) {
  const { data, error } = await supabase
    .from('items').insert({ sku, name, unit, min_stock }).select().single();
  if (error) throw error;
  return data;
}