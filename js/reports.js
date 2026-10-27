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