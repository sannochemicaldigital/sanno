// js/journals.js
import { supabase } from './supabase-client.js';

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
// BUAT JURNAL (header + lines, dengan rollback)
// ============================================================
export async function createJournal({
  journal_date, description, ref_no = null,
  currency_code = 'IDR', exchange_rate = null, lines
}) {
  if (!lines || lines.length === 0) {
    throw new Error('Jurnal harus punya minimal 1 baris');
  }

  // 1. Tentukan kurs
  const rate = exchange_rate ?? await getRate(currency_code, journal_date);

  // 2. Validasi & hitung base
  let totalDebit = 0, totalCredit = 0;
  const prepared = lines.map(l => {
    const debit  = Number(l.debit  || 0);
    const credit = Number(l.credit || 0);

    if (debit > 0 && credit > 0) {
      throw new Error('Baris tidak boleh debit & kredit sekaligus');
    }

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

  // 3. Generate nomor jurnal: JV-YYYYMM-XXXX
  const ym = journal_date.slice(0, 7).replace('-', '');
  const { count, error: cntErr } = await supabase
    .from('journals')
    .select('*', { count: 'exact', head: true })
    .like('journal_no', `JV-${ym}-%`);
  if (cntErr) throw cntErr;
  const journal_no = `JV-${ym}-${String((count || 0) + 1).padStart(4, '0')}`;

  // 4. Ambil user id dari SESSION (bukan getUser — lebih andal)
  const { data: { session } } = await supabase.auth.getSession();
  const userId = session?.user?.id ?? null;

  // 5. Insert header
  const { data: header, error: hErr } = await supabase
    .from('journals')
    .insert({
      journal_no,
      journal_date,
      description,
      ref_no,
      currency_code,
      exchange_rate: rate,
      created_by: userId
    })
    .select()
    .single();
  if (hErr) throw hErr;

  // 6. Insert lines
  const rows = prepared.map(p => ({ ...p, journal_id: header.id }));
  const { error: lErr } = await supabase.from('journal_lines').insert(rows);

  if (lErr) {
    // Rollback manual: hapus header agar tidak ada jurnal kosong
    await supabase.from('journals').delete().eq('id', header.id);
    throw lErr;
  }

  return header;
}

// ============================================================
// DAFTAR JURNAL
// ============================================================
export async function listJournals({ from = null, to = null, limit = 100 } = {}) {
  let q = supabase.from('journals')
    .select('*')
    .order('journal_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (from) q = q.gte('journal_date', from);
  if (to)   q = q.lte('journal_date', to);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

// ============================================================
// HAPUS JURNAL (header + lines otomatis via ON DELETE CASCADE)
// ============================================================
export async function deleteJournal(journalId) {
  const { error } = await supabase.from('journals').delete().eq('id', journalId);
  if (error) throw error;
}