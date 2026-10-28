// js/sales-order.js
import { supabase } from './supabase-client.js';

// ============================================================
// LIST SO (dengan filter role otomatis via RLS)
// ============================================================
export async function listSOs({ status = null, limit = 100 } = {}) {
  let q = supabase.from('sales_orders')
    .select(`
      *,
      partners!inner(code, name),
      profiles!sales_id(email, full_name)
    `)
    .order('id', { ascending: false })
    .limit(limit);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

// ============================================================
// GET SO + LINES
// ============================================================
export async function getSO(soId) {
  const { data: header, error: hErr } = await supabase
    .from('sales_orders')
    .select(`
      *,
      partners!inner(code, name),
      profiles!sales_id(email, full_name)
    `)
    .eq('id', soId).single();
  if (hErr) throw hErr;

  const { data: lines, error: lErr } = await supabase
    .from('sales_order_lines')
    .select('*, items!inner(sku, name, unit)')
    .eq('so_id', soId).order('id');
  if (lErr) throw lErr;

  return { ...header, lines };
}

// ============================================================
// CREATE SO
// ============================================================
export async function createSO({ so_date, partner_id, description, lines }) {
  const { data, error } = await supabase.rpc('create_sales_order', {
    p_so_date: so_date,
    p_partner_id: partner_id,
    p_description: description,
    p_lines: lines
  });
  if (error) throw error;
  return data; // so_id
}

// ============================================================
// EDIT SO (hanya draft)
// ============================================================
export async function editSO(soId, { so_date, partner_id, description, lines }) {
  const { error } = await supabase.rpc('edit_sales_order', {
    p_so_id: soId,
    p_so_date: so_date,
    p_partner_id: partner_id,
    p_description: description,
    p_lines: lines
  });
  if (error) throw error;
}

// ============================================================
// SUBMIT
// ============================================================
export async function submitSO(soId) {
  const { error } = await supabase.rpc('submit_so_for_approval', { p_so_id: soId });
  if (error) throw error;
}

// ============================================================
// CANCEL
// ============================================================
export async function cancelSO(soId, reason) {
  const { error } = await supabase.rpc('cancel_sales_order', { p_so_id: soId, p_reason: reason });
  if (error) throw error;
}

// ============================================================
// APPROVE / REJECT / VOID (dipakai di approval page)
// ============================================================
export async function approveSO(soId) {
  const { data, error } = await supabase.rpc('approve_so', { p_so_id: soId });
  if (error) throw error;
  return data; // status baru
}

export async function rejectSO(soId, reason) {
  const { error } = await supabase.rpc('reject_so', { p_so_id: soId, p_reason: reason });
  if (error) throw error;
}

export async function voidSO(soId, reason) {
  const { error } = await supabase.rpc('void_so', { p_so_id: soId, p_reason: reason });
  if (error) throw error;
}