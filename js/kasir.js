// js/kasir.js
import { supabase } from './supabase-client.js';

export async function createCashSale({ cash_date, description, lines }) {
  const { data, error } = await supabase.rpc('create_cash_sale', {
    p_cash_date: cash_date,
    p_description: description,
    p_lines: lines
  });
  if (error) throw error;
  return data; // cash_id
}

export async function listCashSales({ from = null, to = null, limit = 100 } = {}) {
  let q = supabase.from('cash_sales')
    .select('*')
    .order('cash_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (from) q = q.gte('cash_date', from);
  if (to)   q = q.lte('cash_date', to);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function getCashSale(cashId) {
  const { data: header, error: hErr } = await supabase
    .from('cash_sales').select('*').eq('id', cashId).single();
  if (hErr) throw hErr;

  const { data: lines, error: lErr } = await supabase
    .from('cash_sale_lines')
    .select('*, items!inner(sku, name, unit)')
    .eq('cash_id', cashId).order('id');
  if (lErr) throw lErr;

  return { ...header, lines };
}