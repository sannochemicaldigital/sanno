// js/cash-bank-opname.js
// Data layer: Opname Saldo Kas & Bank (SQL-v11.27).
// Aturan proyek: TANPA DOM, tanpa insert/update manual — semua penulisan
// lewat RPC SECURITY DEFINER di database.

import { supabase } from './supabase-client.js';

export const SELISIH_ACCOUNT_CODE = '1-1900';

// Akun yang ikut opname: asset aktif berkode 1-10xx (kas) / 1-11xx (bank).
// Harus sama dengan helper public._cbo_accounts() di SQL-v11.27.
export function isCashBankCode(code) {
  const c = String(code || '');
  return c.startsWith('1-10') || c.startsWith('1-11');
}

export async function listCashBankAccounts() {
  const { data, error } = await supabase
    .from('accounts')
    .select('id, code, name, type, is_active')
    .eq('is_active', true)
    .eq('type', 'asset')
    .order('code');
  if (error) throw error;
  return (data || []).filter(a => isCashBankCode(a.code));
}

// ---------- daftar & detail ----------
export async function listCashBankOpnames(opts = {}) {
  const { from = null, to = null, status = null, limit = 100, offset = 0 } = opts;
  const { data, error } = await supabase.rpc('list_cash_bank_opnames', {
    p_from: from,
    p_to: to,
    p_status: status,
    p_limit: limit,
    p_offset: offset
  });
  if (error) throw error;
  return data || [];
}

export async function getCashBankOpname(opnameId) {
  const { data, error } = await supabase.rpc('get_cash_bank_opname', {
    p_opname_id: opnameId
  });
  if (error) throw error;
  if (!data) throw new Error('Opname tidak ditemukan');
  return {
    header: data.header || {},
    lines: Array.isArray(data.lines) ? data.lines : [],
    summary: data.summary || {}
  };
}

// ---------- buat & isi ----------
export async function createCashBankOpname({ opnameDate, notes = null, accountCodes = null }) {
  const { data, error } = await supabase.rpc('create_cash_bank_opname', {
    p_opname_date: opnameDate,
    p_notes: notes,
    p_account_codes: (accountCodes && accountCodes.length) ? accountCodes : null
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('RPC create_cash_bank_opname tidak mengembalikan data');
  return row;
}

export async function saveCashBankOpnameLines(opnameId, lines) {
  const { data, error } = await supabase.rpc('save_cash_bank_opname_lines', {
    p_opname_id: opnameId,
    p_lines: Array.isArray(lines) ? lines : []
  });
  if (error) throw error;
  return data || {};
}

export async function refreshCashBankOpname(opnameId) {
  const { data, error } = await supabase.rpc('refresh_cash_bank_opname', {
    p_opname_id: opnameId
  });
  if (error) throw error;
  return data || {};
}

// ---------- transisi status ----------
export async function submitCashBankOpname(opnameId) {
  const { data, error } = await supabase.rpc('submit_cash_bank_opname', {
    p_opname_id: opnameId
  });
  if (error) throw error;
  return data || {};
}

export async function rejectCashBankOpname(opnameId, reason) {
  const { data, error } = await supabase.rpc('reject_cash_bank_opname', {
    p_opname_id: opnameId,
    p_reason: reason
  });
  if (error) throw error;
  return data || {};
}

export async function cancelCashBankOpname(opnameId, reason) {
  const { data, error } = await supabase.rpc('cancel_cash_bank_opname', {
    p_opname_id: opnameId,
    p_reason: reason
  });
  if (error) throw error;
  return data || {};
}

// ---------- eksekusi (posting jurnal OPK-) & unpost ----------
export async function executeCashBankOpname(opnameId, dryRun = false) {
  const { data, error } = await supabase.rpc('execute_cash_bank_opname', {
    p_opname_id: opnameId,
    p_dry_run: !!dryRun
  });
  if (error) throw error;
  return data || {};
}

export async function unpostCashBankOpname(opnameId) {
  const { data, error } = await supabase.rpc('unpost_cash_bank_opname', {
    p_opname_id: opnameId
  });
  if (error) throw error;
  return data || {};
}

// ---------- saldo akun penampung selisih (1-1900) ----------
export async function getSelisihAccountBalance(code = SELISIH_ACCOUNT_CODE) {
  const { data, error } = await supabase
    .from('v_account_balance')
    .select('code, balance')
    .eq('code', code)
    .maybeSingle();
  if (error) throw error;
  return Number(data?.balance || 0);
}
