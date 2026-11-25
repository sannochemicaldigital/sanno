// js/journal-form.js
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission } from './permissions.js';
import { listAccounts } from './accounts.js';
import { listPartners } from './partners.js';
import { listItems } from './items.js';
import {
  createJournal, listJournals, getRate,
  getJournal, updateJournal, reverseJournal, deleteJournal,
  pickHeaderCurrency
} from './journals.js';
import { getProfileDirectory } from './users.js';
import { supabase } from './supabase-client.js';

const BASE_CURRENCY = 'IDR';

// Deteksi valuta dari NAMA akun ("Bank CIMB USD", "Piutang Dagang USD", ...).
// CATATAN PENTING: accounts.is_fx_monetary TIDAK dipakai sebagai penanda akun
// valas, karena SQL-v10.1 menandai SEMUA akun moneter = true — termasuk bank
// IDR 1-1100 Bank BCA dan 1-1110 Bank CIMB. Flag itu hanya berarti "direvaluasi
// di Trial Balance kurs pajak", bukan "akun ini menampung USD".
const CURRENCY_HINTS = ['USD', 'SGD', 'EUR', 'JPY', 'CNY', 'GBP', 'AUD'];
function accountCurrencyHint(acc) {
  if (!acc) return null;
  const nm = String(acc.name || '').toUpperCase();
  return CURRENCY_HINTS.find(c => nm.includes(c)) || null;
}

const state = {
  accounts: [],
  partners: [],
  items: [],
  currencies: [],
  accountsById: {},
  rateCache: {},
  userMap: new Map(),
  lineCount: 0,
  editingId: null,
  perms: {
    create: false, edit: false, reversal: false, delete: false
  }
};

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => el.className = 'toast', 2800);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function fmt(n) {
  return 'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });
}
function num(n) {
  return Number(n || 0).toLocaleString('id-ID',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function currencyOptions(selected = BASE_CURRENCY) {
  const list = state.currencies.length
    ? state.currencies
    : [{ code: BASE_CURRENCY, name: 'Rupiah' }];
  return list.map(c =>
    `<option value="${esc(c.code)}"${c.code === selected ? ' selected' : ''}>${esc(c.code)}</option>`
  ).join('');
}

(async () => {
  const user = await requireAuth();
  if (!user) return;

  const role = await requirePageAccess('journal');
  if (!role) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  await renderNav(document.getElementById('mainNav'), 'journal');

  // Muat permission
  state.perms.create   = await hasPermission('finance.journal.create');
  state.perms.edit     = await hasPermission('finance.journal.edit');
  state.perms.reversal = await hasPermission('finance.journal.reversal');
  state.perms.delete   = await hasPermission('finance.journal.delete');

  // Kalau tidak punya permission create, sembunyikan form
  if (!state.perms.create) {
    document.getElementById('form-journal').style.display = 'none';
    document.getElementById('formTitle').textContent = 'Tidak ada akses membuat jurnal';
  } else {
    document.querySelector('[name=journal_date]').value = new Date().toISOString().slice(0, 10);
    await loadMaster();
    await loadCurrencies();
    try { state.userMap = await getProfileDirectory(); }
    catch (e) { console.warn('Gagal memuat direktori user:', e?.message || e); }

    document.getElementById('addLineBtn').addEventListener('click', () => addLine());
    document.getElementById('resetBtn').addEventListener('click', resetForm);
    document.getElementById('cancelEditBtn').addEventListener('click', resetForm);
    document.getElementById('currencySelect').addEventListener('change', onCurrencyChange);
    document.querySelector('[name=journal_date]').addEventListener('change', () => {
      // tanggal berubah -> kurs master bisa berbeda
      state.rateCache = {};
      document.querySelectorAll('#journalLines .line-row').forEach(div => {
        const cur = String(div.querySelector('.line-currency').value || BASE_CURRENCY).trim();
        if (cur !== BASE_CURRENCY) fillRateFromDb(div, cur);
      });
    });
    document.getElementById('form-journal').addEventListener('submit', onSubmit);
    // Kurs default header -> ikut mengisi baris yang belum diubah manual
    document.querySelector('[name=exchange_rate]').addEventListener('input', () => {
      const docCur = String(document.getElementById('currencySelect').value || BASE_CURRENCY).trim();
      const docRate = Number(document.querySelector('[name=exchange_rate]').value) || 0;
      if (docCur === BASE_CURRENCY || !(docRate > 0)) return;
      document.querySelectorAll('#journalLines .line-row').forEach(div => {
        if (div.dataset.curTouched === '1') return;
        if (div.querySelector('.line-currency').value !== docCur) return;
        div.querySelector('.line-rate').value = docRate;
      });
      recalcTotals();
    });

    addLine();
    addLine();
  }

  await renderJournals();
})();

async function loadMaster() {
  const [accs, parts, its] = await Promise.all([
    listAccounts(), listPartners(), listItems()
  ]);
  state.accounts = accs;
  state.partners = parts;
  state.items = its;
  state.accountsById = Object.fromEntries(accs.map(a => [a.id, a]));
}

async function loadCurrencies() {
  try {
    const { data, error } = await supabase
      .from('currencies')
      .select('code, name, is_base')
      .eq('is_active', true)
      .order('is_base', { ascending: false });
    if (error) throw error;

    state.currencies = (data || []).map(c => ({
      code: String(c.code || '').trim(),
      name: c.name,
      is_base: c.is_base
    }));

    const sel = document.getElementById('currencySelect');
    sel.innerHTML = state.currencies.map(c =>
      `<option value="${esc(c.code)}"${c.is_base ? ' selected' : ''}>${esc(c.code)} — ${esc(c.name)}</option>`
    ).join('');
  } catch (err) {
    console.warn('Gagal muat currency:', err.message);
  }
}

// Ganti mata uang DOKUMEN (header). Baris yang belum pernah diubah manual ikut
// mengikuti; baris yang sudah dipilih sendiri valutanya dibiarkan.
function onCurrencyChange(e) {
  const cur = String(e.target.value || BASE_CURRENCY).trim().toUpperCase();
  const isBase = cur === BASE_CURRENCY;
  const rateInp = document.querySelector('[name=exchange_rate]');

  document.getElementById('rateRow').style.display = isBase ? 'none' : 'block';
  if (isBase) rateInp.value = '';
  state.rateCache = {};

  document.querySelectorAll('#journalLines .line-row').forEach(div => {
    const curSel = div.querySelector('.line-currency');
    if (!curSel) return;
    if (div.dataset.curTouched === '1') {
      if (curSel.value === cur) {
        const rateField = div.querySelector('.line-rate');
        if (isBase) rateField.value = 1;
        else if (!Number(rateField.value) || Number(rateField.value) === 1) {
          const hr = Number(rateInp.value);
          if (hr > 0) rateField.value = hr;
          else fillRateFromDb(div, cur);
        }
      }
      return;
    }
    curSel.value = cur;
    applyLineCurrency(div);
  });

  recalcTotals();
}

function addLine(preset = null) {
  state.lineCount++;
  const id = state.lineCount;
  const wrap = document.getElementById('journalLines');
  const headerCur = String(document.getElementById('currencySelect').value || BASE_CURRENCY).trim();

  const div = document.createElement('div');
  div.className = 'line-row';
  div.dataset.lineId = id;
  div.innerHTML = `
    <div class="lf lf-account"><label>Akun</label>
      <select class="line-account" data-field="account_id" required>
        <option value="">— pilih akun —</option>
        ${state.accounts.map(a =>
          `<option value="${a.id}">${esc(a.code)} — ${esc(a.name)}</option>`
        ).join('')}
      </select>
    </div>
    <div class="lf lf-partner"><label>Partner</label>
      <select class="line-partner" data-field="partner_id">
        <option value="">— (opsional) —</option>
        ${state.partners.map(p =>
          `<option value="${p.id}">${esc(p.name)} (${p.type})</option>`
        ).join('')}
      </select>
    </div>
    <div class="lf lf-cur"><label>Valuta</label>
      <select class="line-currency" data-field="currency_code">
        ${currencyOptions(preset?.currency_code || headerCur)}
      </select>
    </div>
    <div class="lf lf-rate"><label>Kurs</label>
      <input type="number" class="line-rate" data-field="exchange_rate"
             min="0" step="0.000001" placeholder="1">
    </div>
    <div class="lf lf-debit"><label>Debit</label>
      <input type="number" class="line-debit" data-field="debit" placeholder="0" min="0" step="0.01">
    </div>
    <div class="lf lf-credit"><label>Kredit</label>
      <input type="number" class="line-credit" data-field="credit" placeholder="0" min="0" step="0.01">
    </div>
    <div class="lf lf-base"><label>Rupiah</label>
      <span class="line-base">Rp 0</span>
    </div>
    <button type="button" class="line-remove" title="Hapus baris">×</button>
  `;
  wrap.appendChild(div);

  div.querySelector('.line-remove').addEventListener('click', () => {
    div.remove();
    recalcTotals();
  });

  div.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', () => {
      const field = inp.dataset.field;
      if (field === 'debit' && Number(inp.value) > 0) {
        div.querySelector('.line-credit').value = '';
      }
      if (field === 'credit' && Number(inp.value) > 0) {
        div.querySelector('.line-debit').value = '';
      }
      recalcTotals();
    });
  });

  div.querySelector('.line-currency').addEventListener('change', () => {
    div.dataset.curTouched = '1';
    applyLineCurrency(div);
    auditFxAccount(div);
    recalcTotals();
  });

  div.querySelector('.line-account').addEventListener('change', () => {
    const accId = Number(div.querySelector('.line-account').value);
    const acc = state.accountsById[accId];
    const partnerSel = div.querySelector('.line-partner');
    // Kolom akun sengaja sempit -> tampilkan nama lengkap lewat tooltip
    div.querySelector('.line-account').title = acc ? `${acc.code} — ${acc.name}` : '';
    if (acc && (acc.code.startsWith('1-12') || acc.code.startsWith('2-11'))) {
      partnerSel.style.borderColor = '#f59e0b';
      partnerSel.title = 'Partner wajib untuk akun piutang/hutang';
    } else {
      partnerSel.style.borderColor = '';
      partnerSel.title = '';
    }

    // Akun valas (nama memuat kode valuta: "Bank CIMB USD", "Piutang Dagang USD"):
    // sarankan valuta dokumen untuk baris ini. Akun bank IDR (1-1100 / 1-1110)
    // TIDAK diusulkan, karena is_fx_monetary juga true untuk akun moneter IDR.
    const curSel = div.querySelector('.line-currency');
    const hint = accountCurrencyHint(acc);
    if (hint && div.dataset.curTouched !== '1' && curSel.value === BASE_CURRENCY) {
      const docCur = String(document.getElementById('currencySelect').value || BASE_CURRENCY).trim();
      if (docCur !== BASE_CURRENCY) {
        curSel.value = docCur;
        applyLineCurrency(div);
        recalcTotals();
      }
    }
    auditFxAccount(div);
  });

  applyLineCurrency(div);
  if (preset) setLineValues(div, preset);
  recalcTotals();
  return div;
}

// Sesuaikan input kurs dengan valuta baris:
// IDR -> kurs 1 (tidak bisa diubah), valas -> kurs boleh diisi.
function applyLineCurrency(div) {
  const cur = String(div.querySelector('.line-currency').value || BASE_CURRENCY).trim();
  const rateField = div.querySelector('.line-rate');

  if (cur === BASE_CURRENCY) {
    rateField.value = 1;
    rateField.disabled = true;
    rateField.title = 'IDR selalu kurs 1';
    return;
  }

  rateField.disabled = false;
  rateField.title = `Kurs ${cur} ke IDR (boleh diubah)`;
  if (!Number(rateField.value) || Number(rateField.value) === 1) {
    rateField.value = '';
    const docCur = String(document.getElementById('currencySelect').value || BASE_CURRENCY).trim();
    const docRate = Number(document.querySelector('[name=exchange_rate]').value) || 0;
    if (docCur === cur && docRate > 0) {
      rateField.value = docRate;
    } else {
      fillRateFromDb(div, cur);
    }
  }
}

// Ambil kurs otomatis dari master exchange_rates (tanggal <= tanggal jurnal)
async function fillRateFromDb(div, cur) {
  const date = document.querySelector('[name=journal_date]').value
    || new Date().toISOString().slice(0, 10);
  const key = cur + '|' + date;
  try {
    let rate = state.rateCache[key];
    if (rate == null) {
      rate = await getRate(cur, date);
      state.rateCache[key] = rate;
    }
    if (!div.isConnected) return;
    const rateField = div.querySelector('.line-rate');
    if (!Number(rateField.value)) {
      rateField.value = rate;
      recalcTotals();
    }
  } catch (err) {
    console.warn(`Kurs ${cur} tidak ditemukan:`, err.message);
  }
}

// Penanda lunak: akun valas (nama memuat USD dsb.) diisi valuta IDR.
// Kasus inilah yang dulu membuat jurnal pembelian USD tercatat "rupiah" di akun
// valas. Bukan error (nilainya tetap seimbang), hanya penanda supaya valuta
// baris diperiksa sebelum simpan. Akun bank IDR tidak pernah ditandai, sehingga
// input jurnal 1 baris seperti biasa tidak terganggu.
function auditFxAccount(div) {
  const accSel = div.querySelector('.line-account');
  const curSel = div.querySelector('.line-currency');
  if (!accSel || !curSel) return;
  const acc = state.accountsById[Number(accSel.value)];
  const hint = accountCurrencyHint(acc);
  const isIdr = String(curSel.value || BASE_CURRENCY).trim() === BASE_CURRENCY;
  if (hint && isIdr) {
    curSel.style.borderColor = '#f59e0b';
    curSel.title = `Akun ${acc.code} (${acc.name}) adalah akun valas ${hint}. `
      + `Kalau transaksi ini dalam ${hint}, pilih valuta ${hint} pada baris ini.`;
  } else {
    curSel.style.borderColor = '';
    curSel.title = '';
  }
}

// Isi satu baris dari data (dipakai saat edit jurnal)
function setLineValues(div, v) {
  if (!v) return;
  if (v.account_id) {
    const accSel = div.querySelector('.line-account');
    accSel.value = v.account_id;
    accSel.dispatchEvent(new Event('change'));
  }
  if (v.partner_id) div.querySelector('.line-partner').value = v.partner_id;
  if (v.currency_code) {
    div.querySelector('.line-currency').value = String(v.currency_code).trim();
    applyLineCurrency(div);
  }
  if (v.exchange_rate && Number(v.exchange_rate) > 0) {
    div.querySelector('.line-rate').value = v.exchange_rate;
  }
  if (Number(v.debit) > 0)  div.querySelector('.line-debit').value  = v.debit;
  if (Number(v.credit) > 0) div.querySelector('.line-credit').value = v.credit;
  auditFxAccount(div);
}

function collectLines() {
  const rows = document.querySelectorAll('#journalLines .line-row');
  const lines = [];
  rows.forEach(r => {
    const account_id = Number(r.querySelector('.line-account').value) || null;
    const partner_id = Number(r.querySelector('.line-partner').value) || null;
    const currency_code = String(r.querySelector('.line-currency').value || BASE_CURRENCY).trim();
    const debit = Number(r.querySelector('.line-debit').value) || 0;
    const credit = Number(r.querySelector('.line-credit').value) || 0;
    if (!account_id && !debit && !credit) return;

    const rate = currency_code === BASE_CURRENCY
      ? 1
      : (Number(r.querySelector('.line-rate').value) || 0);

    lines.push({
      account_id, partner_id, currency_code,
      exchange_rate: rate,
      debit, credit,
      debit_base: +(debit * rate).toFixed(2),
      credit_base: +(credit * rate).toFixed(2),
      _row: lines.length + 1
    });
  });
  return lines;
}

function recalcTotals() {
  // 1) Preview rupiah per baris
  document.querySelectorAll('#journalLines .line-row').forEach(div => {
    const cur = String(div.querySelector('.line-currency').value || BASE_CURRENCY).trim();
    const rate = cur === BASE_CURRENCY ? 1 : (Number(div.querySelector('.line-rate').value) || 0);
    const d = Number(div.querySelector('.line-debit').value) || 0;
    const c = Number(div.querySelector('.line-credit').value) || 0;
    const base = (d - c) * rate;
    const el = div.querySelector('.line-base');
    el.textContent = fmt(base);
    el.className = 'line-base'
      + (base ? '' : ' base-zero')
      + (base < 0 ? ' base-credit' : '');
  });

  const lines = collectLines();

  // 2) Total NOMINAL per mata uang (valas saja; IDR sudah terwakili di basis)
  const byCur = {};
  lines.forEach(l => {
    const t = byCur[l.currency_code] || (byCur[l.currency_code] = { d: 0, c: 0 });
    t.d += l.debit;
    t.c += l.credit;
  });
  const nonBase = Object.keys(byCur).filter(c => c !== BASE_CURRENCY);
  const curEl = document.getElementById('totalByCurrency');
  if (nonBase.length) {
    curEl.innerHTML = nonBase.map(c => {
      const t = byCur[c];
      return `<span class="sum-cur-item"><b>${esc(c)}</b> — Debit ${num(t.d)} | Kredit ${num(t.c)}</span>`;
    }).join('');
    curEl.style.display = 'flex';
  } else {
    curEl.innerHTML = '';
    curEl.style.display = 'none';
  }

  // 3) Total basis rupiah + status balance
  const totalD = lines.reduce((s, l) => s + l.debit_base, 0);
  const totalC = lines.reduce((s, l) => s + l.credit_base, 0);
  document.getElementById('totalDebit').textContent = fmt(totalD);
  document.getElementById('totalCredit').textContent = fmt(totalC);

  const status = document.getElementById('balanceStatus');
  const saveBtn = document.getElementById('saveBtn');
  const diff = Math.abs(totalD - totalC);

  // Kurs valas wajib ada
  const missingRate = lines.filter(l => l.currency_code !== BASE_CURRENCY && !(l.exchange_rate > 0));
  if (missingRate.length) {
    const curs = [...new Set(missingRate.map(l => l.currency_code))].join(', ');
    status.textContent = `Kurs ${curs} belum diisi`;
    status.className = 'balance-bad';
    saveBtn.disabled = true;
    return;
  }

  if (lines.length >= 2 && totalD > 0 && diff < 0.01) {
    status.textContent = '✓ Balance';
    status.className = 'balance-ok';
    saveBtn.disabled = false;
  } else if (totalD === 0 && totalC === 0) {
    status.textContent = 'Belum ada nilai';
    status.className = 'balance-bad';
    saveBtn.disabled = true;
  } else {
    status.textContent = `Selisih: ${fmt(diff)}`;
    status.className = 'balance-bad';
    saveBtn.disabled = true;
  }
}

function resetForm() {
  document.getElementById('form-journal').reset();
  document.querySelector('[name=journal_date]').value = new Date().toISOString().slice(0, 10);
  document.getElementById('journalLines').innerHTML = '';
  document.getElementById('rateRow').style.display = 'none';
  state.lineCount = 0;
  state.editingId = null;
  state.rateCache = {};
  document.getElementById('formTitle').textContent = 'Jurnal Baru';
  document.getElementById('saveBtn').textContent = 'Simpan Jurnal';
  document.getElementById('cancelEditBtn').style.display = 'none';
  addLine();
  addLine();
}

async function onSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const btn = document.getElementById('saveBtn');
  const isEditing = state.editingId !== null;

  if (isEditing && !state.perms.edit) {
    toast('Tidak ada akses edit jurnal', true);
    return;
  }
  if (!isEditing && !state.perms.create) {
    toast('Tidak ada akses membuat jurnal', true);
    return;
  }

  btn.disabled = true;
  btn.textContent = isEditing ? 'Mengupdate...' : 'Menyimpan...';

  try {
    const lines = collectLines();
    if (lines.length < 2) throw new Error('Minimal 2 baris jurnal');

    for (const l of lines) {
      if (!l.account_id) throw new Error(`Baris ${l._row}: akun belum dipilih`);
      const acc = state.accountsById[l.account_id];
      if (acc && (acc.code.startsWith('1-12') || acc.code.startsWith('2-11')) && !l.partner_id) {
        throw new Error(`Baris akun ${acc.code} ${acc.name} wajib pilih partner`);
      }
      if (l.currency_code !== BASE_CURRENCY && !(l.exchange_rate > 0)) {
        throw new Error(`Baris ${l._row}: kurs ${l.currency_code} belum diisi`);
      }
    }

    // Mata uang header otomatis mengikuti baris bila semua baris satu valuta
    const docCur = String(f.currency_code.value || BASE_CURRENCY).trim();
    let docRate = docCur === BASE_CURRENCY ? 1 : (Number(f.exchange_rate.value) || null);
    if (docCur !== BASE_CURRENCY && !docRate) {
      docRate = await getRate(docCur, f.journal_date.value);
    }
    const headerCur = pickHeaderCurrency(lines, docCur, docRate ?? 1);

    const payload = {
      journal_date: f.journal_date.value,
      description: f.description.value.trim(),
      ref_no: f.ref_no.value.trim() || null,
      currency_code: headerCur.currency_code,
      exchange_rate: headerCur.exchange_rate,
      lines
    };

    if (isEditing) {
      await updateJournal(state.editingId, payload);
      toast('✓ Jurnal berhasil diupdate');
    } else {
      const header = await createJournal(payload);
      toast(`✓ Jurnal ${header.journal_no} tersimpan`);
    }

    resetForm();
    await renderJournals();
  } catch (err) {
    toast('Gagal simpan: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = state.editingId !== null ? 'Update Jurnal' : 'Simpan Jurnal';
  }
}

async function renderJournals() {
  const wrap = document.getElementById('journalList');
  try {
    const list = await listJournals({ limit: 20 });
    if (!list.length) {
      wrap.innerHTML = '<div style="color:#9ca3af;font-size:14px;">Belum ada jurnal.</div>';
      return;
    }

    const ids = list.map(j => j.id);
    const { data: sums } = await supabase
      .from('journal_lines')
      .select('journal_id, debit_base, credit_base, currency_code')
      .in('journal_id', ids);

    const sumMap = {};
    (sums || []).forEach(r => {
      const s = sumMap[r.journal_id] || (sumMap[r.journal_id] = { d: 0, c: 0, curs: new Set() });
      s.d += Number(r.debit_base);
      s.c += Number(r.credit_base);
      if (r.currency_code) s.curs.add(String(r.currency_code).trim());
    });

    wrap.innerHTML = list.map(j => {
      const s = sumMap[j.id] || { d: 0, c: 0, curs: new Set() };
      const headCur = String(j.currency_code || 'IDR').trim();
      let cur = headCur !== 'IDR' ? ` (${headCur} @${j.exchange_rate})` : '';
      if (s.curs.size > 1) cur += ' · multi-valuta';
      const isReversed = j.reversed_by !== null;
      const isReversal = j.reversal_of !== null;
      const badge = isReversed
        ? `<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:4px;font-size:11px;margin-left:6px;">REVERSED</span>`
        : (isReversal
          ? `<span style="background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:4px;font-size:11px;margin-left:6px;">REVERSAL</span>`
          : '');

      const showEdit     = state.perms.edit     && !isReversed && !isReversal;
      const showReversal = state.perms.reversal && !isReversed && !isReversal;
      const showDelete   = state.perms.delete   && !isReversal;

      const buttons = [];
      if (showEdit) buttons.push(
        `<button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" data-edit="${j.id}">Edit</button>`
      );
      if (showReversal) buttons.push(
        `<button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;background:#fef3c7;color:#92400e;" data-reverse="${j.id}" data-no="${esc(j.journal_no)}">Reversal</button>`
      );
      if (showDelete) buttons.push(
        `<button class="btn btn-danger" style="padding:4px 10px;font-size:12px;" data-delete="${j.id}" data-no="${esc(j.journal_no)}">Hapus</button>`
      );

      const buttonsHtml = buttons.length
        ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">${buttons.join('')}</div>`
        : '';

      const creator = j.created_by
        ? esc(state.userMap.get(j.created_by) || 'user tidak dikenal')
        : '—';

      return `
        <div class="journal-list-item">
          <div><b>${esc(j.journal_no)}</b>${badge} — ${esc(j.description || '')}</div>
          <div class="meta">${j.journal_date}${cur} · Debit ${fmt(s.d)} · Kredit ${fmt(s.c)} · Input: ${creator}</div>
          ${buttonsHtml}
        </div>`;
    }).join('');

    wrap.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => loadEdit(Number(btn.dataset.edit)));
    });
    wrap.querySelectorAll('[data-reverse]').forEach(btn => {
      btn.addEventListener('click', () => onReverse(Number(btn.dataset.reverse), btn.dataset.no));
    });
    wrap.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => onDelete(Number(btn.dataset.delete), btn.dataset.no));
    });
  } catch (err) {
    wrap.innerHTML = `<div style="color:#b91c1c;font-size:13px;">Gagal muat: ${esc(err.message)}</div>`;
  }
}

async function loadEdit(journalId) {
  try {
    if (!state.perms.edit) throw new Error('Tidak ada akses edit jurnal');
    const j = await getJournal(journalId);
    state.editingId = journalId;

    const f = document.getElementById('form-journal');
    f.journal_date.value = j.journal_date;
    f.description.value = j.description || '';
    f.ref_no.value = j.ref_no || '';
    f.currency_code.value = String(j.currency_code || 'IDR').trim();
    onCurrencyChange({ target: f.currency_code });
    f.exchange_rate.value = f.currency_code.value !== 'IDR' ? (j.exchange_rate || '') : '';

    document.getElementById('journalLines').innerHTML = '';
    state.lineCount = 0;

    for (const l of j.lines) {
      const lineCur = String(l.currency_code || j.currency_code || 'IDR').trim();
      const lineRate = Number(l.exchange_rate)
        || (lineCur === 'IDR' ? 1 : Number(j.exchange_rate) || 0);

      const row = addLine({
        account_id: l.account_id,
        partner_id: l.partner_id,
        currency_code: lineCur,
        exchange_rate: lineRate,
        debit:  Number(l.debit)  > 0 ? l.debit  : null,
        credit: Number(l.credit) > 0 ? l.credit : null
      });
      row.dataset.curTouched = '1';
    }
    recalcTotals();

    document.getElementById('formTitle').textContent = `Edit Jurnal — ${j.journal_no}`;
    document.getElementById('saveBtn').textContent = 'Update Jurnal';
    document.getElementById('cancelEditBtn').style.display = 'inline-block';
    f.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    toast('Gagal memuat jurnal: ' + err.message, true);
  }
}

async function onReverse(journalId, journalNo) {
  if (!state.perms.reversal) { toast('Tidak ada akses reversal', true); return; }
  if (!confirm(
    `Reversal jurnal ${journalNo}?\n\n` +
    `Sistem akan membuat jurnal balik otomatis. Jurnal asli tetap tersimpan ` +
    `dengan tanda REVERSED.`
  )) return;
  try {
    const header = await reverseJournal(journalId);
    toast(`✓ Reversal dibuat: ${header.journal_no}`);
    if (state.editingId === journalId) resetForm();
    await renderJournals();
  } catch (err) {
    toast('Gagal reversal: ' + (err.message || err), true);
  }
}

async function onDelete(journalId, journalNo) {
  if (!state.perms.delete) { toast('Tidak ada akses hapus jurnal', true); return; }
  if (!confirm(
    `HAPUS PERMANEN jurnal ${journalNo}?\n\n` +
    `Tindakan ini tidak bisa dibatalkan. Untuk koreksi normal, gunakan Reversal.`
  )) return;
  if (!confirm(`Konfirmasi sekali lagi: hapus permanen ${journalNo}?`)) return;
  try {
    await deleteJournal(journalId);
    toast(`✓ Jurnal ${journalNo} dihapus permanen`);
    if (state.editingId === journalId) resetForm();
    await renderJournals();
  } catch (err) {
    toast('Gagal hapus: ' + (err.message || err), true);
  }
}