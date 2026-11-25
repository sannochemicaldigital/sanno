// js/bank-accounts.js
import { supabase } from './supabase-client.js';

// ============================================================
// LIST SEMUA REKENING (aktif & nonaktif)
// ============================================================
export async function listBankAccounts({ activeOnly = false } = {}) {
  let q = supabase
    .from('bank_accounts')
    .select(`
      id, account_id, bank_name, account_no, account_name,
      branch, is_active, sort_order, created_at, updated_at,
      accounts!account_id(code, name)
    `)
    .order('sort_order', { ascending: true })
    .order('bank_name', { ascending: true });
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// ============================================================
// AMBIL SATU REKENING
// ============================================================
export async function getBankAccount(id) {
  const { data, error } = await supabase
    .from('bank_accounts')
    .select(`
      id, account_id, bank_name, account_no, account_name,
      branch, is_active, sort_order,
      accounts!account_id(code, name)
    `)
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

// ============================================================
// BUAT REKENING BARU
// ============================================================
export async function createBankAccount({
  account_id, bank_name, account_no, account_name,
  branch = null, sort_order = 0, is_active = true
}) {
  const { data, error } = await supabase
    .from('bank_accounts')
    .insert({
      account_id,
      bank_name,
      account_no,
      account_name,
      branch,
      sort_order,
      is_active
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ============================================================
// UPDATE REKENING
// ============================================================
export async function updateBankAccount(id, {
  account_id, bank_name, account_no, account_name,
  branch, sort_order, is_active
}) {
  const { data, error } = await supabase
    .from('bank_accounts')
    .update({
      account_id,
      bank_name,
      account_no,
      account_name,
      branch: branch || null,
      sort_order: sort_order ?? 0,
      is_active,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ============================================================
// HAPUS REKENING
// ============================================================
export async function deleteBankAccount(id) {
  const { error } = await supabase
    .from('bank_accounts')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// ============================================================
// LIST AKUN COA BANK (untuk dropdown account_id)
// ============================================================
export async function listBankCoaAccounts() {
  const { data, error } = await supabase
    .from('accounts')
    .select('id, code, name')
    .like('code', '1-11%')
    .eq('is_active', true)
    .order('code');
  if (error) throw error;
  return data || [];
}

// ============================================================
// KURS BUKU RATA-RATA STOK VALAS DI SATU AKUN
// ------------------------------------------------------------
// Dipakai halaman Hutang (pembayaran USD dari rekening valas).
// Kurs buku = nilai buku akun dibagi saldo valas:
//     rate = SUM(debit_base - credit_base) / SUM(debit - credit)
// Hanya baris jurnal dengan mata uang yang diminta yang dihitung,
// s.d. tanggal pembayaran (opsional).
//
// Catatan: RPC lama (mis. add_purchase_payment) menyisipkan
// journal_lines tanpa currency_code (NULL = ikut journals.currency_code),
// jadi mata uang baris dibaca dari journals.currency_code bila NULL.
//
// Hasil: { account_id, code, name, currency, saldo_valas, saldo_idr, rate }
//        rate = null bila saldo valas 0 (belum ada stok).
// ============================================================
export async function getValasBookRate(coaCode, currency = 'USD', asOf = null) {
  const code = String(coaCode || '').trim();
  const cur = String(currency || 'USD').trim().toUpperCase();
  if (!code) throw new Error('Kode akun wajib diisi');

  const { data: acc, error: accErr } = await supabase
    .from('accounts')
    .select('id, code, name')
    .eq('code', code)
    .maybeSingle();
  if (accErr) throw accErr;
  if (!acc) throw new Error(`Akun ${code} tidak ditemukan`);

  let q = supabase
    .from('journal_lines')
    .select('debit, credit, debit_base, credit_base, currency_code, journals!inner(journal_date, currency_code)')
    .eq('account_id', acc.id);
  if (asOf) q = q.lte('journals.journal_date', asOf);

  const { data, error } = await q;
  if (error) throw error;

  let valas = 0;
  let idr = 0;
  (data || []).forEach(l => {
    const lineCur = String(l.currency_code || l.journals?.currency_code || 'IDR')
      .trim().toUpperCase();
    if (lineCur !== cur) return;
    valas += Number(l.debit || 0) - Number(l.credit || 0);
    idr   += Number(l.debit_base || 0) - Number(l.credit_base || 0);
  });

  const saldoValas = Math.round(valas * 100) / 100;
  const saldoIdr   = Math.round(idr * 100) / 100;
  const rate = Math.abs(saldoValas) > 0.005 ? saldoIdr / saldoValas : null;

  return {
    account_id: acc.id,
    code: acc.code,
    name: acc.name,
    currency: cur,
    saldo_valas: saldoValas,
    saldo_idr: saldoIdr,
    rate
  };
}

// ============================================================
// KURS BUKU RATA-RATA STOK VALAS — GABUNGAN SELURUH AKUN VALAS
// ------------------------------------------------------------
// Fallback bila akun yang dipilih BELUM punya stok valas di GL
// (mis. rekening valas baru / transaksi bank belum pernah dijurnal).
// Yang dipakai: nilai buku gabungan akun valas (is_fx_monetary = true)
// dibagi saldo valas gabungan, s.d. tanggal tertentu (opsional).
//
// Hasil: { currency, saldo_valas, saldo_idr, rate, accounts: [{code,name,saldo_valas}] }
//        rate = null bila gabungan saldo valas 0.
// ============================================================
export async function getValasBookRateAcrossAccounts(currency = 'USD', asOf = null) {
  const cur = String(currency || 'USD').trim().toUpperCase();

  const { data: accs, error: accErr } = await supabase
    .from('accounts')
    .select('id, code, name')
    .eq('is_fx_monetary', true)
    .eq('is_active', true);
  if (accErr) throw accErr;
  const ids = (accs || []).map(a => a.id);
  if (!ids.length) {
    return { currency: cur, saldo_valas: 0, saldo_idr: 0, rate: null, accounts: [] };
  }

  // Ambil baris per halaman supaya tidak terpotong batas baris PostgREST.
  const PAGE = 1000;
  const rows = [];
  for (let page = 0; page < 40; page++) {
    let q = supabase
      .from('journal_lines')
      .select('account_id, debit, credit, debit_base, credit_base, currency_code, journals!inner(journal_date, currency_code)')
      .in('account_id', ids);
    if (asOf) q = q.lte('journals.journal_date', asOf);
    const from = page * PAGE;
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }

  let valas = 0;
  let idr = 0;
  const perAcc = new Map();
  rows.forEach(l => {
    const lineCur = String(l.currency_code || l.journals?.currency_code || 'IDR')
      .trim().toUpperCase();
    if (lineCur !== cur) return;
    const d = Number(l.debit || 0) - Number(l.credit || 0);
    const b = Number(l.debit_base || 0) - Number(l.credit_base || 0);
    valas += d;
    idr += b;
    const key = String(l.account_id);
    const prev = perAcc.get(key) || 0;
    perAcc.set(key, prev + d);
  });

  const saldoValas = Math.round(valas * 100) / 100;
  const saldoIdr = Math.round(idr * 100) / 100;
  const rate = Math.abs(saldoValas) > 0.005 ? saldoIdr / saldoValas : null;

  const byId = new Map((accs || []).map(a => [String(a.id), a]));
  const accounts = [...perAcc.entries()]
    .filter(([, s]) => Math.abs(s) > 0.005)
    .map(([id, s]) => ({
      code: byId.get(id)?.code || id,
      name: byId.get(id)?.name || '',
      saldo_valas: Math.round(s * 100) / 100
    }))
    .sort((a, b) => Math.abs(b.saldo_valas) - Math.abs(a.saldo_valas));

  return { currency: cur, saldo_valas: saldoValas, saldo_idr: saldoIdr, rate, accounts };
}