// js/tax-rates.js
// Data layer KURS PAJAK (KMK) — tabel public.tax_exchange_rates.
// Dipakai halaman Rekonsiliasi Bank: opsi "Kurs Pajak KMK" di modal Buat Jurnal
// dan tab "Kurs Pajak (KMK)".
//
// Semua akses lewat RPC SECURITY DEFINER (SQL/SQL-v11.13-kurs-pajak-kmk.sql):
//   get_tax_exchange_rate(p_currency, p_date)          -> kurs berlaku <= tanggal
//   list_tax_exchange_rates(p_currency, p_from, p_to, p_limit)
//   upsert_tax_exchange_rates(p_currency, p_rows jsonb)
//   delete_tax_exchange_rate(p_currency, p_date)
// Penulisan dijaga permission finance.bank.recon di sisi database.
//
// CATATAN: tabel ini SAMA dengan yang dipakai Trial Balance pajak
// (get_trial_balance_tax), jadi mengisi kurs di sini juga memperbaiki
// revaluasi. app.js getRate()/journals.js memakai exchange_rates (kurs buku),
// BUKAN tabel ini — jangan dicampur.
import { supabase } from './supabase-client.js';

// Mata uang yang lazim dipakai di aplikasi; user tetap boleh mengetik kode lain.
export const TAX_CURRENCIES = ['USD', 'SGD', 'EUR', 'JPY', 'CNY', 'AUD', 'GBP'];

function normCurrency(cur) {
  return String(cur || 'USD').trim().toUpperCase() || 'USD';
}

function normDate(d) {
  return d ? String(d).trim().slice(0, 10) : null;
}

// Kurs pajak yang BERLAKU pada tanggal itu = KMK terakhir dengan
// rate_date <= date. Mengembalikan null bila belum ada data.
// Hasil: { currency_code, rate_date, rate_to_idr } atau null
export async function getTaxRate(currency, date = null) {
  const cur = normCurrency(currency);
  if (cur === 'IDR') {
    return { currency_code: 'IDR', rate_date: normDate(date), rate_to_idr: 1 };
  }
  const { data, error } = await supabase.rpc('get_tax_exchange_rate', {
    p_currency: cur,
    p_date: normDate(date)
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || row.rate_to_idr == null) return null;
  return {
    currency_code: String(row.currency_code || cur).trim(),
    rate_date: normDate(row.rate_date),
    rate_to_idr: Number(row.rate_to_idr)
  };
}

// Daftar kurs pajak (terbaru dulu).
// Hasil: [{ currency_code, rate_date, rate_to_idr }]
export async function listTaxRates({ currency = 'USD', from = null, to = null, limit = 300 } = {}) {
  const { data, error } = await supabase.rpc('list_tax_exchange_rates', {
    p_currency: normCurrency(currency),
    p_from: normDate(from),
    p_to: normDate(to),
    p_limit: Number(limit) || 300
  });
  if (error) throw error;
  return (data || []).map(r => ({
    currency_code: String(r.currency_code || '').trim(),
    rate_date: normDate(r.rate_date),
    rate_to_idr: Number(r.rate_to_idr)
  }));
}

// Simpan banyak kurs sekaligus (upsert per currency_code + rate_date).
// rows: [{ rate_date: 'YYYY-MM-DD', rate_to_idr: 16600 }, ...]
// Hasil: { currency_code, saved }
export async function upsertTaxRates(currency, rows) {
  const cur = normCurrency(currency);
  const payload = (rows || [])
    .map(r => ({ rate_date: normDate(r.rate_date), rate_to_idr: Number(r.rate_to_idr) }))
    .filter(r => r.rate_date && Number.isFinite(r.rate_to_idr) && r.rate_to_idr > 0);
  if (!payload.length) throw new Error('Tidak ada baris kurs yang valid untuk disimpan.');
  const { data, error } = await supabase.rpc('upsert_tax_exchange_rates', {
    p_currency: cur,
    p_rows: payload
  });
  if (error) throw error;
  return data || { currency_code: cur, saved: 0 };
}

// Hapus satu baris kurs pajak. Hasil: { deleted }
export async function deleteTaxRate(currency, date) {
  const { data, error } = await supabase.rpc('delete_tax_exchange_rate', {
    p_currency: normCurrency(currency),
    p_date: normDate(date)
  });
  if (error) throw error;
  return data || { deleted: 0 };
}
