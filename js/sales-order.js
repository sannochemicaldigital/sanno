// js/sales-order.js
import { supabase } from './supabase-client.js';

// ============================================================
// LIST SO
// ============================================================
export async function listSOs({ status = null, limit = 100 } = {}) {
  let q = supabase.from('sales_orders')
    .select(`
      *,
      partners!inner(code, name)
    `)
    .order('id', { ascending: false })
    .limit(limit);
  if (status) q = q.eq('status', status);
  const { data: orders, error } = await q;
  if (error) throw error;

  const salesIds = [...new Set(orders.map(o => o.sales_id).filter(Boolean))];
  let profilesMap = {};
  if (salesIds.length) {
    const { data: profiles, error: pErr } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .in('id', salesIds);
    if (!pErr) {
      profilesMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));
    }
  }

  return orders.map(o => ({
    ...o,
    profiles: profilesMap[o.sales_id] || null
  }));
}

// ============================================================
// GET SO + LINES
// ============================================================
export async function getSO(soId) {
  const { data: header, error: hErr } = await supabase
    .from('sales_orders')
    .select(`
      *,
      partners!inner(code, name, phone, email, address)
    `)
    .eq('id', soId).single();
  if (hErr) throw hErr;

  if (header.sales_id) {
    const { data: prof } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .eq('id', header.sales_id)
      .single();
    header.profiles = prof || null;
  }

  // v7.F1 — tambah display_name, display_name_source
  const { data: lines, error: lErr } = await supabase
    .from('sales_order_lines')
    .select('*, display_name, display_name_source, items!inner(sku, name, unit)')
    .eq('so_id', soId).order('id');
  if (lErr) throw lErr;

  return { ...header, lines };
}

// ============================================================
// CREATE SO
// ============================================================
export async function createSO({
  so_date, partner_id, description, lines, payment_terms_days = 30
}) {
  const { data, error } = await supabase.rpc('create_sales_order', {
    p_so_date: so_date,
    p_partner_id: partner_id,
    p_description: description,
    p_lines: lines,
    p_payment_terms_days: payment_terms_days
  });
  if (error) throw error;

  const soId = data;
  const { data: so } = await supabase
    .from('sales_orders')
    .select('so_no')
    .eq('id', soId)
    .single();

  return {
    id: soId,
    so_no: so?.so_no || `#${soId}`
  };
}

// ============================================================
// EDIT SO (hanya draft)
// ============================================================
export async function editSO(soId, {
  so_date, partner_id, description, lines, payment_terms_days = 30
}) {
  const dueDate = new Date(
    new Date(so_date).getTime() + payment_terms_days * 24 * 60 * 60 * 1000
  ).toISOString().slice(0, 10);

  const { error: hErr } = await supabase
    .from('sales_orders')
    .update({
      payment_terms_days,
      due_date: dueDate
    })
    .eq('id', soId);
  if (hErr) throw hErr;

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
  const { error } = await supabase.rpc('cancel_sales_order', {
    p_so_id: soId, p_reason: reason
  });
  if (error) throw error;
}

// ============================================================
// APPROVE / REJECT / VOID
// ============================================================
export async function approveSO(soId) {
  const { data, error } = await supabase.rpc('approve_so', { p_so_id: soId });
  if (error) throw error;
  return data;
}

export async function rejectSO(soId, reason) {
  const { error } = await supabase.rpc('reject_so', { p_so_id: soId, p_reason: reason });
  if (error) throw error;
}

export async function voidSO(soId, reason) {
  const { error } = await supabase.rpc('void_so', { p_so_id: soId, p_reason: reason });
  if (error) throw error;
}

// ============================================================
// PRICE LIST HELPER
// ============================================================
export async function getPriceForItem(itemId) {
  const { data, error } = await supabase.rpc('get_price_for_item', {
    p_item_id: itemId
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row || null;
}

// ============================================================
// v7.F1 — LIST ITEM + NAMA UNTUK DROPDOWN SO
// Return: [{ item_id, sku, item_name, unit, display_label, display_name, display_source }, ...]
// ============================================================
export async function listItemsForSODropdown(p_search = null) {
  const { data, error } = await supabase.rpc('list_items_for_so_dropdown', {
    p_search: p_search
  });
  if (error) throw error;
  return data || [];
}