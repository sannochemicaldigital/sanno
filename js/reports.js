// js/reports.js
import { supabase } from './supabase-client.js';

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

// ============================================================
// LAPORAN: TRIAL BALANCE
// ============================================================
export async function trialBalance({ from = null, to = null } = {}) {
  // Ambil semua akun aktif
  const { data: accounts, error: aErr } = await supabase
    .from('accounts')
    .select('id, code, name, type, normal_balance')
    .eq('is_active', true)
    .order('code');
  if (aErr) throw aErr;

  // Ambil semua journal_lines dalam periode (pakai join ke journals untuk filter tanggal)
  let q = supabase
    .from('journal_lines')
    .select('account_id, debit_base, credit_base, journals!inner(journal_date)');
  if (from) q = q.gte('journals.journal_date', from);
  if (to)   q = q.lte('journals.journal_date', to);
  const { data: lines, error: lErr } = await q;
  if (lErr) throw lErr;

  // Agregasi per akun
  const agg = {};
  for (const l of lines) {
    const k = l.account_id;
    agg[k] = agg[k] || { d: 0, c: 0 };
    agg[k].d += Number(l.debit_base);
    agg[k].c += Number(l.credit_base);
  }

  return accounts.map(a => {
    const s = agg[a.id] || { d: 0, c: 0 };
    const balance = a.normal_balance === 'D' ? (s.d - s.c) : (s.c - s.d);
    return {
      code: a.code,
      name: a.name,
      type: a.type,
      normal_balance: a.normal_balance,
      total_debit: s.d,
      total_credit: s.c,
      balance
    };
  });
}

// ============================================================
// LAPORAN: CASHFLOW (mutasi akun kas & bank)
// ============================================================
export async function cashflow({ from = null, to = null } = {}) {
  // Akun kas/bank = kode 1-10xx dan 1-11xx
  const { data: accounts, error: aErr } = await supabase
    .from('accounts')
    .select('id, code, name')
    .or('code.like.1-10%,code.like.1-11%')
    .eq('is_active', true)
    .order('code');
  if (aErr) throw aErr;

  const accIds = accounts.map(a => a.id);
  if (accIds.length === 0) return { accounts: [], rows: [], summary: [] };

  let q = supabase
    .from('journal_lines')
    .select('account_id, debit_base, credit_base, memo, journals!inner(id, journal_no, journal_date, description)')
    .in('account_id', accIds);
  if (from) q = q.gte('journals.journal_date', from);
  if (to)   q = q.lte('journals.journal_date', to);
  const { data: lines, error: lErr } = await q;
  if (lErr) throw lErr;

  const accMap = Object.fromEntries(accounts.map(a => [a.id, a]));

  // Baris detail
  const rows = lines.map(l => ({
    journal_date:  l.journals.journal_date,
    journal_no:    l.journals.journal_no,
    description:   l.journals.description,
    account_code:  accMap[l.account_id]?.code,
    account_name:  accMap[l.account_id]?.name,
    debit:         Number(l.debit_base),
    credit:        Number(l.credit_base),
    memo:          l.memo
  })).sort((a, b) => a.journal_date.localeCompare(b.journal_date));

  // Ringkasan per akun
  const summary = accounts.map(a => {
    const accLines = lines.filter(l => l.account_id === a.id);
    const inflow  = accLines.reduce((s, l) => s + Number(l.debit_base), 0);
    const outflow = accLines.reduce((s, l) => s + Number(l.credit_base), 0);
    return {
      code: a.code,
      name: a.name,
      inflow,
      outflow,
      net: inflow - outflow
    };
  });

  return { accounts, rows, summary };
}

// ============================================================
// LAPORAN: AGING PIUTANG PER PELANGGAN
// ============================================================
export async function agingPiutang({ asOf = null } = {}) {
  const cutoff = asOf || new Date().toISOString().slice(0, 10);

  // Ambil semua journal_lines yang menyentuh akun piutang (1-12xx) dan punya partner
  const { data: lines, error } = await supabase
    .from('journal_lines')
    .select(`
      partner_id,
      debit_base,
      credit_base,
      journals!inner(journal_date),
      accounts!inner(code),
      partners!inner(name, type)
    `)
    .like('accounts.code', '1-12%')
    .not('partner_id', 'is', null)
    .lte('journals.journal_date', cutoff);
  if (error) throw error;

  // Filter hanya customer
  const custLines = lines.filter(l => l.partners?.type === 'customer');

  // Agregasi per partner + bucket umur
  const buckets = {}; // { partner_id: { name, b0_30, b31_60, b60p, total } }
  const today = new Date(cutoff);

  for (const l of custLines) {
    const key = l.partner_id;
    if (!buckets[key]) {
      buckets[key] = { name: l.partners.name, b0_30: 0, b31_60: 0, b60p: 0, total: 0 };
    }
    const net = Number(l.debit_base) - Number(l.credit_base);
    const jDate = new Date(l.journals.journal_date);
    const days = Math.floor((today - jDate) / (1000 * 60 * 60 * 24));

    if (days <= 30)       buckets[key].b0_30  += net;
    else if (days <= 60)  buckets[key].b31_60 += net;
    else                  buckets[key].b60p   += net;

    buckets[key].total += net;
  }

  // Hanya tampilkan yang saldo != 0
  return Object.values(buckets)
    .filter(b => Math.abs(b.total) > 0.01)
    .sort((a, b) => b.total - a.total);
}

// ============================================================
// LAPORAN: LABA RUGI
// ============================================================
export async function labaRugi({ from = null, to = null } = {}) {
  const tb = await trialBalance({ from, to });

  // Kelompokkan per tipe
  const revenue  = tb.filter(r => r.type === 'revenue');
  const expense  = tb.filter(r => r.type === 'expense');
  const hpp      = expense.filter(r => r.code.startsWith('5-1')); // HPP
  const opex     = expense.filter(r => !r.code.startsWith('5-1') && !r.code.startsWith('5-9'));
  const otherExp = expense.filter(r => r.code.startsWith('5-9'));

  const totalRevenue  = revenue.reduce((s, r) => s + r.balance, 0);
  const totalHpp      = hpp.reduce((s, r) => s + r.balance, 0);
  const totalOpex     = opex.reduce((s, r) => s + r.balance, 0);
  const totalOtherExp = otherExp.reduce((s, r) => s + r.balance, 0);

  const grossProfit = totalRevenue - totalHpp;
  const operatingProfit = grossProfit - totalOpex;
  const netProfit = operatingProfit - totalOtherExp;

  return {
    revenue, hpp, opex, otherExp,
    totalRevenue, totalHpp, totalOpex, totalOtherExp,
    grossProfit, operatingProfit, netProfit
  };
}

// ============================================================
// LAPORAN: NERACA
// ============================================================
export async function neraca({ asOf = null } = {}) {
  const tb = await trialBalance({ from: null, to: asOf });

  const asset     = tb.filter(r => r.type === 'asset');
  const liability = tb.filter(r => r.type === 'liability');
  const equity    = tb.filter(r => r.type === 'equity');

  // Hitung laba berjalan (revenue - expense) untuk dimasukkan ke ekuitas
  const revenue = tb.filter(r => r.type === 'revenue');
  const expense = tb.filter(r => r.type === 'expense');
  const totalRevenue = revenue.reduce((s, r) => s + r.balance, 0);
  const totalExpense = expense.reduce((s, r) => s + r.balance, 0);
  const currentProfit = totalRevenue - totalExpense;

  const totalAsset     = asset.reduce((s, r) => s + r.balance, 0);
  const totalLiability = liability.reduce((s, r) => s + r.balance, 0);
  const totalEquity    = equity.reduce((s, r) => s + r.balance, 0) + currentProfit;

  return {
    asset, liability, equity,
    totalAsset, totalLiability, totalEquity,
    currentProfit,
    balanced: Math.abs(totalAsset - (totalLiability + totalEquity)) < 0.01
  };
}