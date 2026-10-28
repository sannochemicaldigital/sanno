// js/delivery.js
import { supabase } from './supabase-client.js';

export async function listDOs({ status = null, limit = 100 } = {}) {
  let q = supabase.from('delivery_orders')
    .select(`
      *,
      sales_orders!inner(
        id, so_no, so_date, partner_id, sales_id, total_amount, ppn_amount, grand_total, status,
        partners!inner(code, name)
      )
    `)
    .order('id', { ascending: false })
    .limit(limit);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function getDO(doId) {
  const { data: header, error: hErr } = await supabase
    .from('delivery_orders')
    .select(`
      *,
      sales_orders!inner(
        id, so_no, so_date, partner_id, total_amount, ppn_amount, grand_total, status,
        partners!inner(code, name)
      )
    `)
    .eq('id', doId).single();
  if (hErr) throw hErr;

  const { data: lines, error: lErr } = await supabase
    .from('sales_order_lines')
    .select('id, item_id, qty, unit_price, subtotal, items!inner(sku, name, unit, stock_qty, avg_cost)')
    .eq('so_id', header.sales_orders.id)
    .order('id');
  if (lErr) throw lErr;

  return { ...header, lines };
}

export async function markDelivered(doId) {
  const { data, error } = await supabase.rpc('mark_do_delivered', { p_do_id: doId });
  if (error) throw error;
  return data; // journal_id
}

export async function cancelDO(doId, reason) {
  const { error } = await supabase.rpc('cancel_do', { p_do_id: doId, p_reason: reason });
  if (error) throw error;
}