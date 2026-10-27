// js/journal-form.js
import { requireAuth, logout } from './auth.js';
import { listAccounts } from './accounts.js';
import { listPartners } from './partners.js';
import { listItems } from './items.js';
import { createJournal, listJournals, getRate } from './journals.js';
import { supabase } from './supabase-client.js';

// ---------- State ----------
const state = {
  accounts: [],
  partners: [],
  items: [],
  accountsById: {},
  lineCount: 0
};

// ---------- Utilitas ----------
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
function fmt(n) { return 'Rp ' + Number(n || 0).toLocaleString('id-ID'); }

// ---------- Init ----------
(async () => {
  const user = await requireAuth();
  if (!user) return;
  document.getElementById('logoutBtn').addEventListener('click', logout);

  // Set tanggal default hari ini
  const today = new Date().toISOString().slice(0, 10);
  document.querySelector('[name=journal_date]').value = today;

  // Muat master
  await loadMaster();

  // Isi dropdown currency (dari tabel currencies)
  await loadCurrencies();

  // Event handlers
  document.getElementById('addLineBtn').addEventListener('click', () => addLine());
  document.getElementById('resetBtn').addEventListener('click', resetForm);
  document.getElementById('currencySelect').addEventListener('change', onCurrencyChange);
  document.getElementById('form-journal').addEventListener('submit', onSubmit);

  // Baris awal
  addLine();
  addLine();

  // Daftar jurnal
  await renderJournals();
})();

// ---------- Load master ----------
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
      .from('currencies').select('code, name, is_base')
      .eq('is_active', true).order('is_base', { ascending: false });
    if (error) throw error;
    const sel = document.getElementById('currencySelect');
    sel.innerHTML = data.map(c =>
      `<option value="${c.code}">${c.code} — ${esc(c.name)}</option>`
    ).join('');
  } catch (err) {
    console.warn('Gagal muat currency:', err.message);
  }
}

function onCurrencyChange(e) {
  const isIDR = e.target.value === 'IDR';
  document.getElementById('rateRow').style.display = isIDR ? 'none' : 'block';
}

// ---------- Baris jurnal ----------
function addLine() {
  state.lineCount++;
  const id = state.lineCount;
  const wrap = document.getElementById('journalLines');

  const div = document.createElement('div');
  div.className = 'line-row';
  div.dataset.lineId = id;
  div.innerHTML = `
    <select class="line-account" data-field="account_id" required>
      <option value="">— pilih akun —</option>
      ${state.accounts.map(a =>
        `<option value="${a.id}">${esc(a.code)} — ${esc(a.name)}</option>`
      ).join('')}
    </select>
    <select class="line-partner" data-field="partner_id">
      <option value="">— partner (opsional) —</option>
      ${state.partners.map(p =>
        `<option value="${p.id}">${esc(p.name)} (${p.type})</option>`
      ).join('')}
    </select>
    <input type="number" class="line-debit" data-field="debit" placeholder="Debit" min="0" step="0.01">
    <input type="number" class="line-credit" data-field="credit" placeholder="Kredit" min="0" step="0.01">
    <button type="button" class="line-remove" title="Hapus baris">×</button>
  `;
  wrap.appendChild(div);

  // Events
  div.querySelector('.line-remove').addEventListener('click', () => {
    div.remove();
    recalcTotals();
  });
  div.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', () => {
      // kalau isi debit, kosongkan kredit, dan sebaliknya
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
  div.querySelector('.line-account').addEventListener('change', () => {
    // auto-set partner wajib kalau akun piutang/hutang
    const accId = Number(div.querySelector('.line-account').value);
    const acc = state.accountsById[accId];
    const partnerSel = div.querySelector('.line-partner');
    if (acc && (acc.code.startsWith('1-12') || acc.code.startsWith('2-11'))) {
      partnerSel.style.borderColor = '#f59e0b';
      partnerSel.title = 'Partner wajib untuk akun piutang/hutang';
    } else {
      partnerSel.style.borderColor = '';
      partnerSel.title = '';
    }
  });
  recalcTotals();
}

function collectLines() {
  const rows = document.querySelectorAll('#journalLines .line-row');
  const lines = [];
  rows.forEach(r => {
    const account_id = Number(r.querySelector('.line-account').value) || null;
    const partner_id = Number(r.querySelector('.line-partner').value) || null;
    const debit = Number(r.querySelector('.line-debit').value) || 0;
    const credit = Number(r.querySelector('.line-credit').value) || 0;
    if (!account_id && !debit && !credit) return; // baris kosong, skip
    lines.push({ account_id, partner_id, debit, credit });
  });
  return lines;
}

function recalcTotals() {
  const lines = collectLines();
  const totalD = lines.reduce((s, l) => s + l.debit, 0);
  const totalC = lines.reduce((s, l) => s + l.credit, 0);
  document.getElementById('totalDebit').textContent = fmt(totalD);
  document.getElementById('totalCredit').textContent = fmt(totalC);

  const status = document.getElementById('balanceStatus');
  const saveBtn = document.getElementById('saveBtn');
  const diff = Math.abs(totalD - totalC);

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
  addLine();
  addLine();
}

// ---------- Submit ----------
async function onSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';

  try {
    const lines = collectLines();
    if (lines.length < 2) throw new Error('Minimal 2 baris jurnal');

    // Cek partner wajib untuk akun piutang/hutang
    for (const l of lines) {
      const acc = state.accountsById[l.account_id];
      if (acc && (acc.code.startsWith('1-12') || acc.code.startsWith('2-11')) && !l.partner_id) {
        throw new Error(`Baris akun ${acc.code} ${acc.name} wajib pilih partner`);
      }
    }

    const currency_code = f.currency_code.value;
    let exchange_rate = null;
    if (currency_code !== 'IDR') {
      exchange_rate = Number(f.exchange_rate.value) || await getRate(currency_code, f.journal_date.value);
    }

    const header = await createJournal({
      journal_date: f.journal_date.value,
      description: f.description.value.trim(),
      ref_no: f.ref_no.value.trim() || null,
      currency_code,
      exchange_rate,
      lines
    });

    toast(`✓ Jurnal ${header.journal_no} tersimpan`);
    resetForm();
    await renderJournals();
  } catch (err) {
    toast('Gagal simpan: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Simpan Jurnal';
  }
}

// ---------- Daftar jurnal ----------
async function renderJournals() {
  const wrap = document.getElementById('journalList');
  try {
    const list = await listJournals({ limit: 20 });
    if (!list.length) {
      wrap.innerHTML = '<div style="color:#9ca3af;font-size:14px;">Belum ada jurnal.</div>';
      return;
    }
    // Ambil total per jurnal (debit & credit) via query langsung
    const ids = list.map(j => j.id);
    const { data: sums } = await supabase
      .from('journal_lines')
      .select('journal_id, debit_base, credit_base')
      .in('journal_id', ids);
    const sumMap = {};
    (sums || []).forEach(r => {
      sumMap[r.journal_id] = sumMap[r.journal_id] || { d: 0, c: 0 };
      sumMap[r.journal_id].d += Number(r.debit_base);
      sumMap[r.journal_id].c += Number(r.credit_base);
    });

    wrap.innerHTML = list.map(j => {
      const s = sumMap[j.id] || { d: 0, c: 0 };
      const cur = j.currency_code !== 'IDR' ? ` (${j.currency_code} @${j.exchange_rate})` : '';
      return `
        <div class="journal-list-item">
          <div><b>${esc(j.journal_no)}</b> — ${esc(j.description || '')}</div>
          <div class="meta">
            ${j.journal_date}${cur} · Debit ${fmt(s.d)} · Kredit ${fmt(s.c)}
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    wrap.innerHTML = `<div style="color:#b91c1c;font-size:13px;">Gagal muat: ${esc(err.message)}</div>`;
  }
}