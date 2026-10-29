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
// CEK PERIODE TERKUNCI
// ============================================================
export async function isPeriodLocked(dateStr) {
  const { data, error } = await supabase.rpc('is_period_locked', { p_date: dateStr });
  if (error) throw error;
  return data === true;
}

// ============================================================
// BUAT JURNAL (via RPC dengan guard periode)
// ============================================================
export async function createJournal({
  journal_date, description, ref_no = null,
  currency_code = 'IDR', exchange_rate = null, lines
}) {
  if (!lines || lines.length === 0) {
    throw new Error('Jurnal harus punya minimal 1 baris');
  }

  const rate = exchange_rate ?? await getRate(currency_code, journal_date);

  // Validasi balance di client dulu (biar error cepat & jelas)
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
      debit, credit,
      debit_base, credit_base,
      tax_code:   l.tax_code   ?? null,
      memo:       l.memo       ?? null
    };
  });

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`Jurnal tidak balance: debit ${totalDebit} vs kredit ${totalCredit}`);
  }

  // Panggil RPC (guard periode di database)
  const { data: journalId, error } = await supabase.rpc('create_journal_with_lock', {
    p_journal_date: journal_date,
    p_description: description,
    p_ref_no: ref_no,
    p_currency_code: currency_code,
    p_exchange_rate: rate,
    p_lines: prepared
  });
  if (error) throw error;

  // Ambil header untuk return
  const { data: header, error: hErr } = await supabase
    .from('journals').select('*').eq('id', journalId).single();
  if (hErr) throw hErr;
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
// AMBIL SATU JURNAL + LINES
// ============================================================
export async function getJournal(journalId) {
  const { data: header, error: hErr } = await supabase
    .from('journals').select('*').eq('id', journalId).single();
  if (hErr) throw hErr;

  const { data: lines, error: lErr } = await supabase
    .from('journal_lines').select('*').eq('journal_id', journalId).order('id');
  if (lErr) throw lErr;

  return { ...header, lines };
}

// ============================================================
// UPDATE JURNAL (guard periode di client)
// ============================================================
export async function updateJournal(journalId, {
  journal_date, description, ref_no = null,
  currency_code = 'IDR', exchange_rate = null, lines
}) {
  if (!lines || lines.length === 0) {
    throw new Error('Jurnal harus punya minimal 1 baris');
  }

  // Ambil header lama untuk cek periode
  const old = await getJournal(journalId);
  if (await isPeriodLocked(old.journal_date)) {
    throw new Error(`Periode ${old.journal_date.slice(0,7)} sudah dikunci. Tidak bisa edit.`);
  }
  if (await isPeriodLocked(journal_date)) {
    throw new Error(`Periode ${journal_date.slice(0,7)} sudah dikunci. Tidak bisa edit ke periode ini.`);
  }

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

  const { error: hErr } = await supabase
    .from('journals')
    .update({
      journal_date, description, ref_no,
      currency_code, exchange_rate: rate,
      updated_at: new Date().toISOString()
    })
    .eq('id', journalId);
  if (hErr) throw hErr;

  const { error: dErr } = await supabase
    .from('journal_lines').delete().eq('journal_id', journalId);
  if (dErr) throw dErr;

  const rows = prepared.map(p => ({ ...p, journal_id: journalId }));
  const { error: lErr } = await supabase.from('journal_lines').insert(rows);
  if (lErr) throw lErr;

  return { id: journalId };
}

// ============================================================
// HAPUS JURNAL (via RPC dengan guard periode)
// ============================================================
export async function deleteJournal(journalId) {
  const { error } = await supabase.rpc('delete_journal_with_lock', {
    p_journal_id: journalId
  });
  if (error) throw error;
}

// ============================================================
// REVERSAL JURNAL (guard periode di client)
// ============================================================
export async function reverseJournal(journalId) {
  const original = await getJournal(journalId);

  if (original.reversed_by) {
    throw new Error('Jurnal ini sudah pernah di-reversal');
  }

  // Cek periode: reversal selalu dibuat dengan tanggal hari ini
  const today = new Date().toISOString().slice(0, 10);
  if (await isPeriodLocked(today)) {
    throw new Error(`Periode ${today.slice(0,7)} sudah dikunci. Tidak bisa reversal.`);
  }

  const reversedLines = original.lines.map(l => ({
    account_id: l.account_id,
    partner_id: l.partner_id,
    item_id:    l.item_id,
    debit:      Number(l.credit),
    credit:     Number(l.debit),
    debit_base: Number(l.credit_base),
    credit_base: Number(l.debit_base),
    tax_code:   l.tax_code,
    memo:       `Reversal: ${l.memo || ''}`.trim()
  }));

  const ym = today.slice(0, 7).replace('-', '');
  const { count } = await supabase
    .from('journals').select('*', { count: 'exact', head: true })
    .like('journal_no', `JV-${ym}-%`);
  const journal_no = `JV-${ym}-${String((count || 0) + 1).padStart(4, '0')}`;

  const { data: { session } } = await supabase.auth.getSession();
  const userId = session?.user?.id ?? null;

  const { data: header, error: hErr } = await supabase
    .from('journals')
    .insert({
      journal_no,
      journal_date: today,
      description: `Reversal dari ${original.journal_no}: ${original.description || ''}`.trim(),
      ref_no: original.ref_no,
      currency_code: original.currency_code,
      exchange_rate: original.exchange_rate,
      created_by: userId,
      reversal_of: journalId
    })
    .select().single();
  if (hErr) throw hErr;

  const rows = reversedLines.map(r => ({ ...r, journal_id: header.id }));
  const { error: lErr } = await supabase.from('journal_lines').insert(rows);
  if (lErr) {
    await supabase.from('journals').delete().eq('id', header.id);
    throw lErr;
  }

  const { error: uErr } = await supabase
    .from('journals')
    .update({ reversed_by: header.id })
    .eq('id', journalId);
  if (uErr) throw uErr;

  return header;
}