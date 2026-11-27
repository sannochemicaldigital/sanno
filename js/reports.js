// js/reports.js
import { supabase } from './supabase-client.js';
import { listBankCoaAccounts } from './bank-accounts.js';

// ============================================================
// DASHBOARD BALANCES
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
// SALDO SEMUA REKENING BANK — untuk SATU kartu "Saldo Bank" di dashboard
// ------------------------------------------------------------
// dashboard_mapping hanya memetakan 1 akun per kartu ('bank' -> 1-1100),
// jadi rekening lain (CIMB IDR 1-1110, CIMB USD 1-1120, OCBC 1-1130, ...)
// tidak pernah tampil. Fungsi ini mengambil SEMUA akun COA bank (kode 1-11xx)
// lalu menjumlahkannya dalam satu daftar.
//
// Sumber angka tetap buku besar (v_account_balance = debit_base/credit_base,
// selalu IDR) supaya konsisten dengan laporan & trial balance.
// Nama/no rekening diambil dari Pengaturan > Rekening Bank (bank_accounts)
// bila ada; kalau tabel/nama rekening belum diisi, dipakai nama akun COA.
// Mata uang rekening diambil dari impor rekening koran terakhir
// (bank_statement_imports.currency_code); kalau rekening belum pernah diimpor,
// dipakai valuta dominan baris jurnal. Nominal valas (USD) dihitung dari
// journal_lines.debit/credit per BARIS (currency_code baris, mata uang asli,
// bukan _base) sehingga jurnal campuran USD+IDR tetap benar (v11.7).
// ============================================================
// PLAFON REKENING KORAN (overdraft)
// ------------------------------------------------------------
// Akun-akun berikut BUKAN simpanan biasa: ketiganya fasilitas plafon
// rekening koran (overdraft). Saldo MINUS pada akun ini secara ekonomi
// adalah HUTANG BANK, bukan saldo bank. Karena v_account_balance memberi
// tanda sesuai normal_balance ('D' = debit - kredit), saldo minus di sini
// berarti akun bersaldo kredit.
// ============================================================
export const PLAFON_RK_CODES = ['1-1110', '1-1120', '1-1130'];
const PLAFON_RK_SET = new Set(PLAFON_RK_CODES);
export function isPlafonRk(code) { return PLAFON_RK_SET.has(code); }

// Saldo minus akun plafon RK -> hutang bank (nilai positif).
// Dipakai kartu "Hutang Bank" di dashboard.
export async function plafonRkHutang() {
  const { data, error } = await supabase
    .from('v_account_balance')
    .select('code, name, balance')
    .in('code', PLAFON_RK_CODES);
  if (error) throw error;

  const items = (data || []).map(r => {
    const saldo = Number(r.balance || 0);
    return {
      code: r.code,
      name: r.name,
      balance: saldo,
      hutang: saldo < 0 ? -saldo : 0
    };
  });
  return { total: items.reduce((s, i) => s + i.hutang, 0), items };
}

export async function bankBalanceSummary() {
  // Akun bank = 1-11xx + 1-1010 (BCA-N), lihat EXTRA_BANK_COA_CODES.
  const accounts = await listBankCoaAccounts({ activeOnly: true });
  if (!accounts.length) return { total: 0, items: [] };

  const codes = accounts.map(a => a.code);

  // 1. Saldo buku besar (selalu rupiah)
  const { data: bal, error: balErr } = await supabase
    .from('v_account_balance')
    .select('code, balance')
    .in('code', codes);
  if (balErr) throw balErr;
  const saldo = new Map((bal || []).map(r => [r.code, Number(r.balance || 0)]));

  // 2. Nama & nomor rekening (opsional; kalau belum ada, pakai nama COA)
  const rekening = new Map();     // code -> baris bank_accounts pertama
  const { data: ba, error: baErr } = await supabase
    .from('bank_accounts')
    .select('bank_name, account_no, is_active, sort_order, accounts!account_id(code)')
    .order('is_active', { ascending: false })
    .order('sort_order', { ascending: true });
  if (baErr) console.warn('[bankBalanceSummary] bank_accounts:', baErr.message);
  else {
    for (const r of (ba || [])) {
      const c = r.accounts?.code;
      // satu COA bisa punya >1 baris rekening; ambil satu saja supaya
      // saldo tidak terhitung dobel
      if (c && !rekening.has(c)) rekening.set(c, r);
    }
  }

  // 3. Mata uang rekening.
  //    Prioritas 1: mata uang impor rekening koran paling baru.
  //    Prioritas 2: valuta baris jurnal (v11.7: valuta per baris) — dipakai
  //                 kalau rekening belum pernah punya impor rekening koran.
  const currency = new Map();
  const { data: imp, error: impErr } = await supabase
    .from('bank_statement_imports')
    .select('coa_code, currency_code, period_end')
    .order('period_end', { ascending: false });
  if (impErr) console.warn('[bankBalanceSummary] bank_statement_imports:', impErr.message);
  else {
    for (const r of (imp || [])) {
      if (!r.coa_code || currency.has(r.coa_code)) continue;
      currency.set(r.coa_code, String(r.currency_code || 'IDR').trim().toUpperCase());
    }
  }

  // 4. Nominal asli (stok valas) per akun per valuta.
  //    Diambil dari currency_code BARIS jurnal, bukan header jurnal, supaya
  //    jurnal campuran (USD + IDR dalam satu jurnal) tetap terhitung benar.
  //    Hanya baris NON-IDR yang diambil (baris IDR tidak perlu: nominalnya
  //    sudah sama dengan rupiah buku besar) + baris lama yang currency_code-nya
  //    masih NULL (ikut valuta header jurnal). Diambil bertahap karena
  //    PostgREST membatasi 1000 baris per permintaan.
  const nominal = new Map();      // account_id -> Map(valuta -> nominal)
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('journal_lines')
      .select('id, account_id, debit, credit, currency_code, journals!inner(currency_code)')
      .in('account_id', accounts.map(a => a.id))
      .or('currency_code.is.null,currency_code.neq.IDR')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn('[bankBalanceSummary] nominal valas:', error.message);
      break;
    }
    for (const l of (data || [])) {
      const cur = String(l.currency_code || l.journals?.currency_code || 'IDR')
        .trim().toUpperCase() || 'IDR';
      if (cur === 'IDR') continue;                            // nominal IDR = rupiah
      const per = nominal.get(l.account_id) || new Map();
      per.set(cur, (per.get(cur) || 0) + Number(l.debit || 0) - Number(l.credit || 0));
      nominal.set(l.account_id, per);
    }
    if (!data || data.length < PAGE) break;
  }

  // Valuta dominan dari baris jurnal (nominal absolut terbesar, selain IDR).
  function lineCurrency(accountId) {
    const per = nominal.get(accountId);
    if (!per || !per.size) return null;
    let best = null, bestVal = 0;
    for (const [cur, val] of per) {
      if (Math.abs(val) > Math.abs(bestVal)) { best = cur; bestVal = val; }
    }
    return best;
  }

  const items = accounts.map(a => {
    const rek = rekening.get(a.code) || null;
    const cur = currency.get(a.code) || lineCurrency(a.id) || 'IDR';
    const saldoAkun = saldo.get(a.code) || 0;                 // rupiah (base)
    const plafon = isPlafonRk(a.code);
    const per = nominal.get(a.id) || new Map();
    const nominalAsli = per.has(cur) ? per.get(cur) : null;   // stok valuta akun
    return {
      code: a.code,
      name: a.name,
      bank_name: rek?.bank_name || null,
      account_no: rek?.account_no || null,
      currency: cur,
      balance: saldoAkun,
      balance_native: nominalAsli,                            // nominal asli (USD) kalau valas
      plafon,                                                 // akun plafon rekening koran
      hutang: plafon && saldoAkun < 0 ? -saldoAkun : 0,        // minus plafon = hutang bank
      amount_usd: cur === 'USD' ? nominalAsli : null           // kompatibilitas pemakai lama
    };
  });

  const total = items.reduce((s, i) => s + i.balance, 0);
  const hutangPlafon = items.reduce((s, i) => s + i.hutang, 0);

  return {
    total,                 // saldo bersih (aset - hutang plafon) = penjumlahan semua baris
    bankTotal: total + hutangPlafon,   // aset bank: minus plafon RK dikeluarkan (jadi hutang)
    hutangPlafon,          // total minus akun plafon RK (nilai positif)
    items
  };
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
    if (!l.partners) continue;
    // ✅ FIX: handle 'customer' dan 'both'
    if (l.partners.type !== 'customer' && l.partners.type !== 'both') continue;
    const key = l.partner_id;
    agg[key] = agg[key] || { name: l.partners.name, saldo: 0 };
    agg[key].saldo += Number(l.debit_base) - Number(l.credit_base);
  }
  return Object.values(agg).filter(x => Math.abs(x.saldo) > 0.01);
}

// ============================================================
// TRIAL BALANCE
// ============================================================
export async function trialBalance({ from = null, to = null } = {}) {
  const { data: accounts, error: aErr } = await supabase
    .from('accounts')
    .select('id, code, name, type, normal_balance')
    .eq('is_active', true)
    .order('code');
  if (aErr) throw aErr;

  let q = supabase
    .from('journal_lines')
    .select('account_id, debit_base, credit_base, journals!inner(journal_date)');
  if (from) q = q.gte('journals.journal_date', from);
  if (to)   q = q.lte('journals.journal_date', to);
  const { data: lines, error: lErr } = await q;
  if (lErr) throw lErr;

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
      code: a.code, name: a.name, type: a.type, normal_balance: a.normal_balance,
      total_debit: s.d, total_credit: s.c, balance
    };
  });
}

// ============================================================
// CASHFLOW
// ============================================================
export async function cashflow({ from = null, to = null } = {}) {
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

  const summary = accounts.map(a => {
    const accLines = lines.filter(l => l.account_id === a.id);
    const inflow  = accLines.reduce((s, l) => s + Number(l.debit_base), 0);
    const outflow = accLines.reduce((s, l) => s + Number(l.credit_base), 0);
    return { code: a.code, name: a.name, inflow, outflow, net: inflow - outflow };
  });

  return { accounts, rows, summary };
}

// ============================================================
// AGING PIUTANG (via RPC aging_piutang — sumber: historical_invoices)
// ============================================================
export async function agingPiutang({ asOf = null } = {}) {
  const { data, error } = await supabase.rpc('aging_piutang', {
    p_as_of: asOf || new Date().toISOString().slice(0, 10)
  });
  if (error) throw error;
  return (data || []).map(r => ({
    name: r.partner_name,
    b0_30: Number(r.b0_30),
    b31_60: Number(r.b31_60),
    b60p: Number(r.b60p),
    total: Number(r.total)
  }));
}

// ============================================================
// AGING HUTANG
// ============================================================
export async function agingHutang({ asOf = null } = {}) {
  const cutoff = asOf || new Date().toISOString().slice(0, 10);

  const { data: lines, error } = await supabase
    .from('journal_lines')
    .select(`
      partner_id, debit_base, credit_base,
      journals!inner(journal_date),
      accounts!inner(code),
      partners!inner(name, type)
    `)
    .like('accounts.code', '2-11%')
    .not('partner_id', 'is', null)
    .lte('journals.journal_date', cutoff);
  if (error) throw error;

  // ✅ FIX: handle 'vendor' dan 'both'
  const vendorLines = lines.filter(l =>
    l.partners?.type === 'vendor' || l.partners?.type === 'both'
  );

  const buckets = {};
  const today = new Date(cutoff);

  for (const l of vendorLines) {
    const key = l.partner_id;
    if (!buckets[key]) {
      buckets[key] = { name: l.partners.name, b0_30: 0, b31_60: 0, b60p: 0, total: 0 };
    }
    // Hutang: kredit menambah, debit mengurangi
    const net = Number(l.credit_base) - Number(l.debit_base);
    const jDate = new Date(l.journals.journal_date);
    const days = Math.floor((today - jDate) / (1000 * 60 * 60 * 24));

    if (days <= 30)       buckets[key].b0_30  += net;
    else if (days <= 60)  buckets[key].b31_60 += net;
    else                  buckets[key].b60p   += net;

    buckets[key].total += net;
  }

  return Object.values(buckets)
    .filter(b => Math.abs(b.total) > 0.01)
    .sort((a, b) => b.total - a.total);
}

// ============================================================
// LABA RUGI
// ============================================================
export async function labaRugi({ from = null, to = null } = {}) {
  const tb = await trialBalance({ from, to });

  const revenue  = tb.filter(r => r.type === 'revenue');
  const expense  = tb.filter(r => r.type === 'expense');
  const hpp      = expense.filter(r => r.code.startsWith('5-1'));
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
// NERACA
// ============================================================
export async function neraca({ asOf = null } = {}) {
  const tb = await trialBalance({ from: null, to: asOf });

  const asset     = tb.filter(r => r.type === 'asset');
  const liability = tb.filter(r => r.type === 'liability');
  const equity    = tb.filter(r => r.type === 'equity');

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

// ============================================================
// LAPORAN: PENJUALAN PER SALES
// ============================================================
export async function salesReport({ from = null, to = null } = {}) {
  let q = supabase
    .from('sales_orders')
    .select('id, so_no, so_date, sales_id, status, total_amount, ppn_amount, grand_total');
  if (from) q = q.gte('so_date', from);
  if (to)   q = q.lte('so_date', to);
  const { data: orders, error: oErr } = await q;
  if (oErr) throw oErr;

  if (!orders || orders.length === 0) return { rows: [], totals: null };

  const salesIds = [...new Set(orders.map(o => o.sales_id).filter(Boolean))];
  let profileMap = {};
  if (salesIds.length) {
    const { data: profiles, error: pErr } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .in('id', salesIds);
    if (!pErr) {
      profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));
    }
  }

  const buckets = {};
  for (const o of orders) {
    const key = o.sales_id || 'unknown';
    if (!buckets[key]) {
      buckets[key] = {
        sales_id: key,
        sales_name: profileMap[key]?.full_name || profileMap[key]?.email || '—',
        sales_email: profileMap[key]?.email || '—',
        total_so: 0,
        draft: 0, pending: 0, approved: 0, rejected: 0,
        posted: 0, cancelled: 0, delivered: 0,
        total_posted: 0,
        total_all: 0
      };
    }
    const b = buckets[key];
    b.total_so += 1;
    b.total_all += Number(o.grand_total || 0);

    switch (o.status) {
      case 'draft':            b.draft++; break;
      case 'pending_approval': b.pending++; break;
      case 'approved':         b.approved++; break;
      case 'rejected':         b.rejected++; break;
      case 'posted':           b.posted++; b.total_posted += Number(o.grand_total || 0); break;
      case 'delivered':        b.delivered++; b.total_posted += Number(o.grand_total || 0); break;
      case 'cancelled':        b.cancelled++; break;
    }
  }

  const rows = Object.values(buckets).sort((a, b) => b.total_posted - a.total_posted);

  const totals = rows.reduce((acc, r) => ({
    total_so:      acc.total_so + r.total_so,
    draft:         acc.draft + r.draft,
    pending:       acc.pending + r.pending,
    approved:      acc.approved + r.approved,
    rejected:      acc.rejected + r.rejected,
    posted:        acc.posted + r.posted,
    cancelled:     acc.cancelled + r.cancelled,
    total_posted:  acc.total_posted + r.total_posted,
    total_all:     acc.total_all + r.total_all
  }), {
    total_so: 0, draft: 0, pending: 0, approved: 0, rejected: 0,
    posted: 0, cancelled: 0, total_posted: 0, total_all: 0
  });

  return { rows, totals };
}

// ============================================================
// BUKU BESAR (LEDGER) PER AKUN — mendukung valuta per baris (v11.7)
// ------------------------------------------------------------
// Kolom nominal memakai mata uang ASLI baris jurnal (journal_lines.debit
// /credit + currency_code), kolom rupiah memakai _base (kurs historis,
// tidak pernah direvaluasi). Saldo berjalan dihitung dua jalur:
//   - saldo valuta asli -> hanya baris yang valutanya = valuta akun
//   - saldo rupiah      -> seluruh baris (kolom base)
// Saldo awal = akumulasi baris bertanggal < `from`.
// ============================================================
export async function ledgerAccountList() {
  const { data, error } = await supabase
    .from('accounts')
    .select('id, code, name, type, is_fx_monetary')
    .eq('is_active', true)
    .order('code');
  if (error) throw error;
  return data || [];
}

// Valuta baris: currency_code baris -> valuta header (data lama) -> IDR
function lineCurrencyOf(line) {
  return String(line.currency_code || line.journals?.currency_code || 'IDR')
    .trim().toUpperCase() || 'IDR';
}

export async function ledgerByAccount({ accountCode, from = null, to = null } = {}) {
  if (!accountCode) throw new Error('Akun belum dipilih');

  const { data: acc, error: accErr } = await supabase
    .from('accounts')
    .select('id, code, name, type, normal_balance, is_fx_monetary')
    .eq('code', accountCode)
    .single();
  if (accErr) throw accErr;

  // Ambil SELURUH baris akun s/d `to` (saldo awal butuh baris sebelum `from`),
  // bertahap karena PostgREST membatasi 1000 baris per permintaan.
  const PAGE = 1000;
  const lines = [];
  for (let offset = 0; ; offset += PAGE) {
    let q = supabase
      .from('journal_lines')
      .select('id, journal_id, debit, credit, debit_base, credit_base, '
        + 'currency_code, exchange_rate, memo, '
        + 'journals!inner(journal_no, journal_date, description, currency_code, '
        + 'exchange_rate, reversed_by, reversal_of)')
      .eq('account_id', acc.id)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (to) q = q.lte('journals.journal_date', to);
    const { data, error } = await q;
    if (error) throw error;
    if (data && data.length) lines.push(...data);
    if (!data || data.length < PAGE) break;
  }

  // Kronologis: tanggal jurnal -> id jurnal -> id baris
  lines.sort((a, b) => {
    const da = a.journals?.journal_date || '';
    const db = b.journals?.journal_date || '';
    if (da !== db) return da < db ? -1 : 1;
    if (Number(a.journal_id) !== Number(b.journal_id)) {
      return Number(a.journal_id) - Number(b.journal_id);
    }
    return Number(a.id) - Number(b.id);
  });

  // Valuta akun = valuta non-IDR dengan perputaran absolut terbesar.
  // (Akun Rupiah yang kebetulan punya 1-2 baris valas tetap dianggap IDR.)
  const turnover = new Map();
  for (const l of lines) {
    const cur = lineCurrencyOf(l);
    if (cur === 'IDR') continue;
    turnover.set(cur, (turnover.get(cur) || 0)
      + Math.abs(Number(l.debit || 0) - Number(l.credit || 0)));
  }
  let currency = 'IDR', bestTurnover = 0;
  for (const [cur, val] of turnover) {
    if (val > bestTurnover) { currency = cur; bestTurnover = val; }
  }
  const isValas = currency !== 'IDR';

  let openNative = 0;
  let openBase = 0;
  let runNative = 0;
  let runBase = 0;
  let sumDebitBase = 0;
  let sumCreditBase = 0;
  const rows = [];

  for (const l of lines) {
    const cur  = lineCurrencyOf(l);
    const d    = Number(l.debit || 0);
    const c    = Number(l.credit || 0);
    const dB   = Number(l.debit_base || 0);
    const cB   = Number(l.credit_base || 0);
    const jd   = l.journals?.journal_date || '';
    const same = cur === currency;          // baris sevaluta dengan akun

    if (from && jd < from) {
      openBase += dB - cB;
      if (same) openNative += d - c;
      continue;
    }

    runBase += dB - cB;
    if (same) runNative += d - c;
    sumDebitBase  += dB;
    sumCreditBase += cB;

    rows.push({
      line_id:        l.id,
      journal_id:     l.journal_id,
      journal_date:   jd,
      journal_no:     l.journals?.journal_no || '',
      description:    l.memo || l.journals?.description || '',
      // v11.34 — status reversal ikut dikirim supaya tombol Hapus cepat di
      // Buku Besar bisa mengikuti aturan halaman Jurnal (jurnal reversal
      // TIDAK boleh dihapus; jejak audit harus tetap ada).
      reversed_by:    l.journals?.reversed_by ?? null,
      reversal_of:    l.journals?.reversal_of ?? null,
      currency:       cur,
      exchange_rate:  Number(l.exchange_rate) || Number(l.journals?.exchange_rate) || null,
      debit:          d,
      credit:         c,
      debit_base:     dB,
      credit_base:    cB,
      balance:        runBase,
      balance_native: same ? runNative : null
    });
  }

  return {
    account: acc,
    currency,
    is_valas: isValas,
    opening: {
      native: isValas ? openNative : openBase,
      base:   openBase
    },
    rows,
    totals: {
      debit:           sumDebitBase,
      credit:          sumCreditBase,
      closing_native:  isValas ? openNative + runNative : openBase + runBase,
      closing_base:    openBase + runBase
    }
  };
}
