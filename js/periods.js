// js/periods.js
import { supabase } from './supabase-client.js';

// ============================================================
// Daftar periode terkunci
// ============================================================
export async function listLockedPeriods() {
  const { data, error } = await supabase
    .from('locked_periods')
    .select(`
      id, year, month, locked_at, notes,
      profiles!locked_by(email, full_name)
    `)
    .order('year', { ascending: false })
    .order('month', { ascending: false });
  if (error) throw error;
  return data || [];
}

// ============================================================
// Kunci periode
// ============================================================
export async function lockPeriod(year, month, notes = null) {
  const { data: { session } } = await supabase.auth.getSession();
  const { data, error } = await supabase
    .from('locked_periods')
    .insert({
      year,
      month,
      locked_by: session?.user?.id ?? null,
      notes
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ============================================================
// Buka kunci periode
// ============================================================
export async function unlockPeriod(id) {
  const { error } = await supabase
    .from('locked_periods')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ============================================================
// Cek apakah periode tertentu terkunci
// ============================================================
export async function checkPeriodLocked(year, month) {
  const { data, error } = await supabase
    .from('locked_periods')
    .select('id')
    .eq('year', year)
    .eq('month', month)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

// ============================================================
// Cek apakah tanggal (YYYY-MM-DD) terkunci
// ============================================================
export async function isDateLocked(dateStr) {
  const d = new Date(dateStr);
  return checkPeriodLocked(d.getFullYear(), d.getMonth() + 1);
}