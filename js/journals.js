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
// MATA UANG & KURS PER BARIS
// ============================================================
function fmtNum(n) {
  return Number(n || 0).toLocaleString('id-ID',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Hitung debit_base/credit_base untuk tiap baris.
// currency_code per baris boleh kosong -> ikut mata uang header (perilaku lama).
// Kurs diambil dari: baris -> header -> master exchange_rates.
export async function prepareJournalLines(lines, {
  headerCurrency = 'IDR', headerRate = 1, journalDate = null
} = {}) {
  const prepared = [];
  const rateCache = {};
  let totalDebit = 0, totalCredit = 0;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const debit  = Number(l.debit  || 0);
    const credit = Number(l.credit || 0);
    if (debit > 0 && credit > 0) {
      throw new Error(`Baris ${i + 1}: tidak boleh debit & kredit sekaligus`);
    }

    const currency = String(l.currency_code || headerCurrency || 'IDR').trim().toUpperCase();
    let rate = 1;
    if (currency !== 'IDR') {
      rate = Number(l.exchange_rate) || Number(headerRate) || 0;
      if (!rate) {
        if (rateCache[currency] === undefined) {
          rateCache[currency] = await getRate(currency, journalDate);
        }
        rate = rateCache[currency];
      }
      if (!(rate > 0)) throw new Error(`Baris ${i + 1}: kurs ${currency} tidak valid`);
    }

    const debit_base  = +(debit  * rate).toFixed(2);
    const credit_base = +(credit * rate).toFixed(2);
    totalDebit  += debit_base;
    totalCredit += credit_base;

    prepared.push({
      account_id: l.account_id,
      partner_id: l.partner_id ?? null,
      item_id:    l.item_id    ?? null,
      debit, credit,
      debit_base, credit_base,
      tax_code:      l.tax_code ?? null,
      memo:          l.memo ?? null,
      currency_code: currency,
      exchange_rate: rate
    });
  }

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(
      `Jurnal tidak balance: debit ${fmtNum(totalDebit)} vs kredit ${fmtNum(totalCredit)} (dalam rupiah)`
    );
  }

  return { prepared, totalDebit, totalCredit };
}

// Mata uang header: kalau semua baris memakai satu mata uang, pakai mata uang
// itu supaya laporan lama (yang membaca journals.currency_code) tetap benar.
// Kalau campuran, pakai mata uang dokumen yang dipilih di form.
export function pickHeaderCurrency(lines, fallbackCurrency = 'IDR', fallbackRate = 1) {
  const list = lines || [];
  const curs = [...new Set(list.map(l =>
    String(l.currency_code || fallbackCurrency || 'IDR').trim().toUpperCase()
  ))];

  if (curs.length === 1) {
    const cur = curs[0];
    const line = list.find(l =>
      String(l.currency_code || fallbackCurrency || 'IDR').trim().toUpperCase() === cur
    );
    const rate = cur === 'IDR'
      ? 1
      : (Number(line?.exchange_rate) || Number(fallbackRate) || 1);
    return { currency_code: cur, exchange_rate: rate };
  }

  return {
    currency_code: String(fallbackCurrency || 'IDR').trim().toUpperCase(),
    exchange_rate: Number(fallbackRate) || 1
  };
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

  const header = pickHeaderCurrency(lines, currency_code, exchange_rate ?? 1);
  const headerRate = header.currency_code === 'IDR'
    ? 1
    : (Number(exchange_rate) || await getRate(header.currency_code, journal_date));

  // Validasi balance di client dulu (biar error cepat & jelas)
  const { prepared } = await prepareJournalLines(lines, {
    headerCurrency: header.currency_code,
    headerRate,
    journalDate: journal_date
  });

  // Panggil RPC (guard periode di database)
  const { data: journalId, error } = await supabase.rpc('create_journal_with_lock', {
    p_journal_date: journal_date,
    p_description: description,
    p_ref_no: ref_no,
    p_currency_code: header.currency_code,
    p_exchange_rate: headerRate,
    p_lines: prepared
  });
  if (error) throw error;

  // Ambil header untuk return
  const { data: created, error: hErr } = await supabase
    .from('journals').select('*').eq('id', journalId).single();
  if (hErr) throw hErr;
  return created;
}

// ============================================================
// DAFTAR JURNAL
// ============================================================
// v11.33 — tambah pencarian teks (journal_no / description / ref_no) + rentang
// tanggal. Sebelumnya halaman Jurnal hanya menampilkan N jurnal terbaru tanpa
// pencarian, sehingga jurnal impor kas lama (KAS-YYYYMM-NNNN / KASADJ-...)
// bertanggal 2020-2025 tidak mungkin ditemukan dari UI.
export async function listJournals({ from = null, to = null, q = null, limit = 100 } = {}) {
  let query = supabase.from('journals')
    .select('*')
    .order('journal_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (from) query = query.gte('journal_date', from);
  if (to)   query = query.lte('journal_date', to);

  // Karakter , ( ) * dan % bermakna khusus di filter PostgREST -> dibuang.
  const term = String(q || '').trim().replace(/[,()%*]/g, ' ').replace(/\s+/g, ' ').trim();
  if (term) {
    query = query.or(
      `journal_no.ilike.%${term}%,description.ilike.%${term}%,ref_no.ilike.%${term}%`
    );
  }

  const { data, error } = await query;
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
// UPDATE JURNAL (via RPC: atomik, guard periode & balance di server)
// ============================================================
// Sejak v11.18 SEMUA tulisan saat edit lewat RPC update_journal_with_lock
// (SECURITY DEFINER). JANGAN kembali ke DML langsung
// (UPDATE journals + DELETE/INSERT journal_lines): jalur itu ditolak 403 oleh
// RLS/GRANT di production dan tidak atomik — kalau INSERT gagal, jurnal
// tertinggal tanpa baris.
export async function updateJournal(journalId, {
  journal_date, description, ref_no = null,
  currency_code = 'IDR', exchange_rate = null, lines
}) {
  if (!journalId) throw new Error('ID jurnal tidak valid');
  if (!lines || lines.length === 0) {
    throw new Error('Jurnal harus punya minimal 1 baris');
  }

  const header = pickHeaderCurrency(lines, currency_code, exchange_rate ?? 1);
  const headerRate = header.currency_code === 'IDR'
    ? 1
    : (Number(exchange_rate) || await getRate(header.currency_code, journal_date));

  // Validasi balance + hitung *_base & mata uang per baris (error cepat di client)
  const { prepared } = await prepareJournalLines(lines, {
    headerCurrency: header.currency_code,
    headerRate,
    journalDate: journal_date
  });

  const { error } = await supabase.rpc('update_journal_with_lock', {
    p_journal_id:    journalId,
    p_journal_date:  journal_date,
    p_description:   description,
    p_ref_no:        ref_no,
    p_currency_code: header.currency_code,
    p_exchange_rate: headerRate,
    p_lines:         prepared
  });
  if (error) throw error;

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
    memo:       `Reversal: ${l.memo || ''}`.trim(),
    // mata uang & kurs per baris ikut jurnal asli (kalau kosong -> header)
    currency_code: String(l.currency_code || original.currency_code || 'IDR').trim(),
    exchange_rate: Number(
      l.exchange_rate ?? (String(l.currency_code || original.currency_code).trim() === 'IDR'
        ? 1
        : original.exchange_rate)
    ) || 1
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