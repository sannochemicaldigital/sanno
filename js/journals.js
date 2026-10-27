// js/journals.js
import { supabase } from './supabase-client.js';

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

export async function createJournal({
  journal_date, description, ref_no = null,
  currency_code = 'IDR', exchange_rate = null, lines
}) {
  if (!lines || lines.length === 0) throw new Error('Jurnal harus punya minimal 1 baris');

  const rate = exchange_rate ?? await getRate(currency_code, journal_date);

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

  const ym = journal_date.slice(0, 7).replace('-', '');
  const { count } = await supabase
    .from('journals').select('*', { count: 'exact', head: true })
    .like('journal_no', `JV-${ym}-%`);
  const journal_no = `JV-${ym}-${String((count || 0) + 1).padStart(4, '0')}`;

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

  const rows = prepared.map(p => ({ ...p, journal_id: header.id }));
  const { error: lErr } = await supabase.from('journal_lines').insert(rows);
  if (lErr) {
    await supabase.from('journals').delete().eq('id', header.id);
    throw lErr;
  }
  return header;
}

export async function listJournals({ from = null, to = null, limit = 100 } = {}) {
  let q = supabase.from('journals').select('*')
    .order('journal_date', { ascending: false }).limit(limit);
  if (from) q = q.gte('journal_date', from);
  if (to)   q = q.lte('journal_date', to);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}