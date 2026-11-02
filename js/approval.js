// js/approval.js
import { supabase } from './supabase-client.js';
import { approveSO, rejectSO, voidSO } from './sales-order.js';

// Daftar SO yang perlu di-approve (pending_approval) + approved (untuk void)
export async function listPendingApprovals() {
  const { data, error } = await supabase
    .from('sales_orders')
    .select(`
      *,
      partners!inner(code, name),
      profiles!sales_id(email, full_name)
    `)
    .in('status', ['pending_approval','approved'])
    .order('id', { ascending: false });
  if (error) throw error;
  return data;
}

export { approveSO, rejectSO, voidSO };
// Ambil lines lengkap untuk 1 SO (termasuk snapshot price list + override)
export async function getSOLines(soId) {
  const { data, error } = await supabase
    .from('sales_order_lines')
    .select(`
      id, item_id, qty, unit_price, subtotal, memo,
      price_list_price, price_list_discount_pct, price_list_effective_price,
      so_discount_pct, so_effective_price,
      price_diff, price_diff_pct,
      price_override_status, price_override_reason,
      price_override_approved_by, price_override_approved_at,
      items!inner(sku, name, unit)
    `)
    .eq('so_id', soId)
    .order('id');
  if (error) throw error;
  return data || [];
}