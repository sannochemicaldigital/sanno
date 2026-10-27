// app.js
// Jalankan di browser / Node (dengan fetch). Membutuhkan:
//   SUPABASE_URL  dan  SUPABASE_ANON_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ylssphgggpmirwiivbvw.supabase.co';   // ganti
const SUPABASE_ANON_KEY = 'sb_publishable_pgXl15Ax0p-0236hTxSGcw_nIJCHMY6';                // ganti

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ============================================================
// AUTH
// ============================================================
export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function logout() {
  await supabase.auth.signOut();
}

export async function currentProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('profiles').select('*').eq('id', user.id).single();
  if (error) throw error;
  return data;
}

// ============================================================
// COA
// ============================================================
export async function listAccounts() {
  const { data, error } = await supabase
    .from('accounts').select('*').eq('is_active', true).order('code');
  if (error) throw error;
  return data;
}

export async function createAccount({ code, name, type, normal_balance, parent_id = null }) {
  const { data, error } = await supabase
    .from('accounts').insert({ code, name, type, normal_balance, parent_id }).select().single();
  if (error) throw error;
  return data;
}

// ============================================================
// PARTNERS
// ============================================================
export async function listPartners(type = null) {
  let q = supabase.from('partners').select('*').eq('is_active', true).order('name');
  if (type) q = q.eq('type', type);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function createPartner(p) {
  const { data, error } = await supabase.from('partners').insert(p).select().single();
  if (error) throw error;
  return data;
}

// ============================================================
// ITEMS
// ============================================================
export async function listItems() {
  const { data, error } = await supabase
    .from('items').select('*').eq('is_active', true).order('sku');
  if (error) throw error;
  return data;
}

export async function createItem({ sku, name, unit = 'pcs', min_stock = 0 }) {
  const { data, error } = await supabase
    .from('items').insert({ sku, name, unit, min_stock }).select().single();
  if (error) throw error;
  return data;
}

// ============================================================
// KURS
// ============================================================
export async function getRate(currency_code, date = null) {
  if (currency_code === 'IDR') return 1;
  let q = supabase.from('exchange_rates')
    .select('rate_to_base').eq('currency_code', currency_code)
    .order('rate_date', { ascending: false }).limit(1);
  if (date) q = q.lte('rate_date', date);
  const { data, error } = await q;
  if (error) throw error;
  if (!data.length) throw new Error(`Kurs ${currency_code} tidak ditemukan`);
  return Number(data[0].rate_to_base);
}

// ============================================================
// JURNAL
// ============================================================
// lines: [{ account_id, partner_id?, item_id?, debit?, credit?, tax_code?, memo? }]
export async function createJournal({
  journal_date,
  description,
  ref_no = null,
  currency_code = 'IDR',
  exchange_rate = null,
  lines
}) {
  if (!lines || lines.length === 0) throw new Error('Jurnal harus punya minimal 1 baris');

  const rate = exchange_rate ?? await getRate(currency_code, journal_date);

  // Hitung base & validasi
  let totalDebit = 0, totalCredit = 0;
  const prepared = lines.map(l => {
    const debit  = Number(l.debit  || 0);
    const credit = Number(l.credit || 0);
    if (debit > 0 && credit > 0) throw new Error('Baris tidak boleh debit & kredit sekaligus');
    const debit_base  = +(debit  * rate).toFixed(2);
    const credit_base = +(credit * rate).toFixed(2);
    totalDebit  += debit_base;
    totalCredit += credit_base;
    return {
      account_id: l.account_id,
      partner_id: l.partner_id ?? null,
      item_id:    l.item_id    ?? null,
      debit, credit, debit_base, credit_base,
      tax_code:   l.tax_code   ?? null,
      memo:       l.memo       ?? null
    };
  });

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`Jurnal tidak balance: debit ${totalDebit} vs kredit ${totalCredit}`);
  }

  // Nomor jurnal
  const ym = journal_date.slice(0, 7).replace('-', '');
  const { count } = await supabase
    .from('journals').select('*', { count: 'exact', head: true })
    .like('journal_no', `JV-${ym}-%`);
  const journal_no = `JV-${ym}-${String((count || 0) + 1).padStart(4, '0')}`;

  // Insert header
  const { data: { user } } = await supabase.auth.getUser();
  const { data: header, error: hErr } = await supabase
    .from('journals')
    .insert({
      journal_no, journal_date, description, ref_no,
      currency_code, exchange_rate: rate,
      created_by: user?.id ?? null
    })
    .select().single();
  if (hErr) throw hErr;

  // Insert lines
  const rows = prepared.map(p => ({ ...p, journal_id: header.id }));
  const { error: lErr } = await supabase.from('journal_lines').insert(rows);
  if (lErr) {
    // rollback manual (delete header)
    await supabase.from('journals').delete().eq('id', header.id);
    throw lErr;
  }

  return header;
}

export async function listJournals({ from = null, to = null, limit = 100 } = {}) {
  let q = supabase.from('journals').select('*').order('journal_date', { ascending: false }).limit(limit);
  if (from) q = q.gte('journal_date', from);
  if (to)   q = q.lte('journal_date', to);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

// ============================================================
// DASHBOARD
// ============================================================
export async function dashboardBalances() {
  const { data, error } = await supabase
    .from('dashboard_mapping')
    .select('card_key, card_label, accounts(code, name)')
    .order('sort_order');
  if (error) throw error;

  const codes = data.map(d => d.accounts?.code).filter(Boolean);
  const { data: bal, error: bErr } = await supabase
    .from('v_account_balance').select('code, balance').in('code', codes);
  if (bErr) throw bErr;

  const map = Object.fromEntries(bal.map(b => [b.code, Number(b.balance)]));
  return data.map(d => ({
    key: d.card_key,
    label: d.card_label,
    balance: d.accounts ? (map[d.accounts.code] ?? 0) : 0
  }));
}

// ============================================================
// PIUTANG PER PELANGGAN
// ============================================================
export async function piutangPerPelanggan() {
  const { data: lines, error } = await supabase
    .from('journal_lines')
    .select('partner_id, debit_base, credit_base, accounts!inner(code), partners!inner(name, type)')
    .like('accounts.code', '1-12%');
  if (error) throw error;

  const agg = {};
  for (const l of lines) {
    if (!l.partners || l.partners.type !== 'customer') continue;
    const key = l.partner_id;
    agg[key] = agg[key] || { name: l.partners.name, saldo: 0 };
    agg[key].saldo += Number(l.debit_base) - Number(l.credit_base);
  }
  return Object.values(agg).filter(x => Math.abs(x.saldo) > 0.01);
}