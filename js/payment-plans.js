// js/payment-plans.js
// Data layer: antrian Rencana Bayar Hutang (SQL-v11.33).
// Tanpa DOM. Semua tulis lewat RPC (tabel read-only untuk authenticated).
import { supabase } from './supabase-client.js';

// ============================================================
// BACA: antrian + invoice + sisa hutang
// ============================================================
// Mengembalikan array urut TANGGAL RENCANA (terdekat di atas), lalu sort_order
// (prioritas manual antar invoice bertanggal sama), lalu id:
//   { id, invoice_id, plan_date, plan_amount, currency, sort_order, note,
//     invoice: { invoice_no, currency, subtotal, total_idr, total_usd,
//                due_date, status, partner: { name } },
//     paid_amount, invoice_total, sisa }
// Rumus sisa SAMA dengan tab Pembayaran:
//   total (currency invoice) - SUM(alokasi pembayaran yang belum dihapus)
export async function listPaymentPlans() {
  const { data, error } = await supabase
    .from('purchase_payment_plans')
    .select(`
      id, invoice_id, plan_date, plan_amount, currency, sort_order, note,
      invoice:purchase_invoices!inner(
        invoice_no, currency, subtotal, total_idr, total_usd, due_date, status,
        partner:partners!inner(name)
      )
    `)
    .order('plan_date', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });

  if (error) throw error;

  const plans = data || [];
  if (!plans.length) return [];

  const invoiceIds = [...new Set(plans.map(p => p.invoice_id))];

  const { data: allocs, error: allocErr } = await supabase
    .from('purchase_payment_allocations')
    .select('invoice_id, amount, purchase_payments!inner(deleted_at)')
    .in('invoice_id', invoiceIds)
    .is('purchase_payments.deleted_at', null);

  if (allocErr) throw allocErr;

  const paidMap = {};
  (allocs || []).forEach(a => {
    paidMap[a.invoice_id] = (paidMap[a.invoice_id] || 0) + Number(a.amount || 0);
  });

  return plans.map(p => {
    const inv = p.invoice || {};
    const total = inv.currency === 'USD'
      ? Number(inv.total_usd || 0)
      : Number(inv.total_idr || 0);
    const paid = paidMap[p.invoice_id] || 0;
    return {
      ...p,
      paid_amount: paid,
      invoice_total: total,
      sisa: Math.max(0, total - paid)
    };
  });
}

// ============================================================
// TULIS (RPC)
// ============================================================
export async function addPaymentPlan({ invoice_id, plan_date, plan_amount, note = null }) {
  const { data, error } = await supabase.rpc('add_payment_plan', {
    p_payload: {
      invoice_id: Number(invoice_id),
      plan_date,
      plan_amount: Number(plan_amount),
      note
    }
  });
  if (error) throw error;
  return data; // id baris baru
}

export async function updatePaymentPlan({ id, plan_date, plan_amount, note = null }) {
  const { error } = await supabase.rpc('update_payment_plan', {
    p_id: Number(id),
    p_plan_date: plan_date,
    p_plan_amount: Number(plan_amount),
    p_note: note
  });
  if (error) throw error;
}

export async function movePaymentPlan(id, direction) {
  const { error } = await supabase.rpc('move_payment_plan', {
    p_id: Number(id),
    p_direction: direction === 'up' ? 'up' : 'down'
  });
  if (error) throw error;
}

export async function deletePaymentPlan(id) {
  const { error } = await supabase.rpc('delete_payment_plan', {
    p_id: Number(id)
  });
  if (error) throw error;
}
