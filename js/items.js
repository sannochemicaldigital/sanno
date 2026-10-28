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
    .from('items')
    .insert({
      sku,
      name,
      unit,
      min_stock,
      stock_qty: 0,       // WAJIB 0 untuk gudang
      avg_cost: 0,        // WAJIB 0 untuk gudang
      is_active: true
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}