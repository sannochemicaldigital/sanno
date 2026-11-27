// js/bank-accounts.js
import { supabase } from './supabase-client.js';

// ============================================================
// KODE COA REKENING BANK DI LUAR KELOMPOK 1-11xx
// ------------------------------------------------------------
// Rekening 1-1010 (BCA-N) sengaja dibuat di luar kelompok 1-11xx, tetapi tetap
// rekening bank: harus muncul di Pengaturan > Bank, dropdown impor rekonsiliasi,
// dan kartu "Saldo Bank" dashboard. Tambahkan kode lain di sini bila ada.
// ============================================================
export const EXTRA_BANK_COA_CODES = ['1-1010'];

// ============================================================
// PLAFON REKENING KORAN (OVERDRAFT) PER AKUN
// ------------------------------------------------------------
// Akun di bawah ini BUKAN rekening simpanan biasa: fasilitas plafon
// rekening koran (overdraft). Saldo MINUS pada akun ini = HUTANG BANK.
//
// Nilai plafon TIDAK di-hardcode: disimpan di
//   accounts.plafon_rk          (numeric, NULL = belum diisi)
//   accounts.plafon_rk_currency (IDR / USD)
// lewat SQL/SQL-v11.35-plafon-rk-per-akun.sql, dan bisa diubah kapan saja
// di Pengaturan > Bank (kartu "Plafon Rekening Koran").
//
// 1-1110 = Bank CIMB Niaga IDR, 1-1120 = Bank CIMB Niaga USD,
// 1-1130 = Bank OCBC NISP IDR.
// ============================================================
export const PLAFON_RK_CODES = ['1-1110', '1-1120', '1-1130'];
const PLAFON_RK_SET = new Set(PLAFON_RK_CODES);
export function isPlafonRk(code) { return PLAFON_RK_SET.has(code); }

// Ambang peringatan pemakaian plafon (persen).
export const PLAFON_WARN_PCT = 80;    // kuning : mendekati plafon
export const PLAFON_CRIT_PCT = 95;    // merah  : plafon hampir penuh
export const PLAFON_OVER_PCT = 100;   // tebal  : melebihi plafon

// ============================================================
// HITUNG PEMAKAIAN PLAFON SATU AKUN
// ------------------------------------------------------------
// plafonAmount   : nilai plafon (accounts.plafon_rk)
// plafonCurrency : mata uang plafon (IDR/USD)
// hutangIdr      : hutang menurut buku besar dalam RUPIAH (positif)
// hutangNative   : hutang dalam MATA UANG PLAFON (positif) — wajib untuk
//                  plafon non-IDR; plafon USD TIDAK boleh dibandingkan
//                  dengan rupiah buku besar (kurs historis per baris).
//
// Hasil null bila plafon belum diisi / 0 (tidak ada pembanding).
// level: 'ok' | 'warn' | 'crit' | 'over'
// ============================================================
export function plafonUsage({
  plafonAmount, plafonCurrency, hutangIdr = 0, hutangNative = null
}) {
  const amount = Number(plafonAmount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const currency = String(plafonCurrency || 'IDR').trim().toUpperCase();
  const pakai = currency === 'IDR'
    ? Math.max(0, Number(hutangIdr || 0))
    : Math.max(0, Number(hutangNative || 0));

  const pct = (pakai / amount) * 100;
  const level = pct >= PLAFON_OVER_PCT ? 'over'
    : pct >= PLAFON_CRIT_PCT ? 'crit'
      : pct >= PLAFON_WARN_PCT ? 'warn'
        : 'ok';

  return {
    currency,
    amount,                                              // nilai plafon
    pakai,                                               // terpakai (valuta plafon)
    sisa: amount - pakai,                                // negatif = kelebihan
    pct,
    pct_label: pct.toLocaleString('id-ID', { maximumFractionDigits: 1 }) + '%',
    level
  };
}

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
// LIST AKUN COA BANK (dropdown account_id, filter rekonsiliasi, laporan)
// ------------------------------------------------------------
// = akun berawalan 1-11 + EXTRA_BANK_COA_CODES.
// ============================================================
export async function listBankCoaAccounts({ activeOnly = true } = {}) {
  const COLS_BASE   = 'id, code, name';
  const COLS_PLAFON = 'id, code, name, plafon_rk, plafon_rk_currency';

  // Dua query lalu digabung: tidak memakai .or() PostgREST supaya tidak
  // bergantung pada sintaks wildcard (%, *) yang mudah salah.
  async function ambil(selectCols) {
    let q = supabase.from('accounts').select(selectCols).like('code', '1-11%');
    if (activeOnly) q = q.eq('is_active', true);
    const { data, error } = await q.order('code');
    if (error) return { error };

    const rows = [...(data || [])];
    if (EXTRA_BANK_COA_CODES.length) {
      let qx = supabase.from('accounts').select(selectCols).in('code', EXTRA_BANK_COA_CODES);
      if (activeOnly) qx = qx.eq('is_active', true);
      const { data: extra, error: extraErr } = await qx;
      if (extraErr) return { error: extraErr };
      rows.push(...(extra || []));
    }
    return { rows };
  }

  let res = await ambil(COLS_PLAFON);
  if (res.error) {
    // Kolom plafon baru ada setelah SQL-v11.35 dieksekusi. Selama migrasi
    // belum dijalankan, ulangi tanpa kolom plafon supaya halaman tetap
    // dapat saldo bank (plafon dianggap belum diisi).
    console.warn('[listBankCoaAccounts] kolom plafon tidak terbaca, fallback:',
      res.error.message || res.error);
    res = await ambil(COLS_BASE);
    if (res.error) throw res.error;
  }

  const seen = new Set();
  return (res.rows || [])
    .filter(r => (seen.has(r.code) ? false : seen.add(r.code)))
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));
}

// ============================================================
// DAFTAR AKUN PLAFON RK + NILAI PLAFONNYA (Pengaturan > Bank)
// ------------------------------------------------------------
// Selalu mengembalikan 3 baris sesuai PLAFON_RK_CODES, termasuk akun yang
// belum ada di COA (id null) supaya kelihatan harus dibuat dulu.
// plafon_tersedia=false -> SQL-v11.35 belum dieksekusi (kolom belum ada),
// nilai plafon tidak bisa dibaca/disimpan.
// ============================================================
export async function listPlafonRkAccounts() {
  const COLS_BASE   = 'id, code, name, is_active';
  const COLS_PLAFON = 'id, code, name, is_active, plafon_rk, plafon_rk_currency';

  const ambil = cols => supabase
    .from('accounts')
    .select(cols)
    .in('code', PLAFON_RK_CODES)
    .order('code');

  let tersedia = true;
  let res = await ambil(COLS_PLAFON);
  if (res.error) {
    tersedia = false;
    console.warn('[listPlafonRkAccounts] kolom plafon belum ada:', res.error.message || res.error);
    res = await ambil(COLS_BASE);
    if (res.error) throw res.error;
  }

  const byCode = new Map((res.data || []).map(a => [a.code, a]));
  return PLAFON_RK_CODES.map(code => {
    const a = byCode.get(code);
    if (!a) {
      return {
        id: null,
        code,
        name: '(akun belum ada di COA)',
        is_active: null,
        plafon_rk: null,
        plafon_rk_currency: 'IDR',
        plafon_tersedia: tersedia
      };
    }
    return {
      ...a,
      plafon_rk: a.plafon_rk ?? null,
      plafon_rk_currency: String(a.plafon_rk_currency || 'IDR').toUpperCase(),
      plafon_tersedia: tersedia
    };
  });
}

// ============================================================
// SIMPAN NILAI PLAFON RK SATU AKUN
// ------------------------------------------------------------
// amount null / '' -> plafon dikosongkan (dianggap tidak ada plafon).
// currency IDR/USD (dipaksa huruf besar).
// ============================================================
export async function updateAccountPlafon(code, { amount = null, currency = 'IDR' } = {}) {
  const kode = String(code || '').trim();
  if (!kode) throw new Error('Kode akun wajib diisi');

  const cur = String(currency || 'IDR').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) throw new Error('Mata uang plafon harus 3 huruf (mis. IDR / USD)');

  const nilai = (amount === null || amount === undefined || amount === '')
    ? null
    : Number(amount);
  if (nilai !== null && (!Number.isFinite(nilai) || nilai < 0)) {
    throw new Error('Nilai plafon tidak valid');
  }

  const { data, error } = await supabase
    .from('accounts')
    .update({ plafon_rk: nilai, plafon_rk_currency: cur })
    .eq('code', kode)
    .select('id, code, name, plafon_rk, plafon_rk_currency');

  if (error) {
    const pesan = String(error.message || '');
    if (String(error.code) === '42703' || /column .* does not exist/i.test(pesan)) {
      throw new Error('Kolom plafon belum ada di database. Jalankan '
        + 'SQL/SQL-v11.35-plafon-rk-per-akun.sql dulu.');
    }
    throw error;
  }
  if (!data || !data.length) throw new Error(`Akun ${kode} tidak ditemukan`);
  return data[0];
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