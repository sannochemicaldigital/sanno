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