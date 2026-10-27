// js/reports-page.js
import { requireAuth, logout } from './auth.js';
import { trialBalance, cashflow, agingPiutang } from './reports.js';

// ---------- State ----------
const state = {
  from: null,
  to: null,
  activeTab: 'tb',
  lastData: null // untuk export CSV
};

// ---------- Utilitas ----------
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => el.className = 'toast', 2500);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function fmt(n) {
  const v = Number(n || 0);
  return v.toLocaleString('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function fmtSigned(n) {
  const v = Number(n || 0);
  const cls = v < 0 ? 'neg' : (v > 0 ? 'pos' : '');
  return `<span class="${cls}">${fmt(v)}</span>`;
}
function periodLabel(from, to) {
  if (!from && !to) return 'Semua periode';
  return `${from || '...'} s/d ${to || '...'}`;
}

// ---------- Init ----------
(async () => {
  const user = await requireAuth();
  if (!user) return;
  document.getElementById('logoutBtn').addEventListener('click', logout);

  // Tanggal default: awal bulan ini s/d hari ini
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  document.getElementById('filterFrom').value = firstOfMonth.toISOString().slice(0, 10);
  document.getElementById('filterTo').value = today.toISOString().slice(0, 10);

  // Tabs
  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTab = btn.dataset.tab;
      document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
      document.getElementById('tab-' + state.activeTab).style.display = 'block';
      loadActive();
    });
  });

  // Filter
  document.getElementById('applyFilter').addEventListener('click', () => {
    state.from = document.getElementById('filterFrom').value || null;
    state.to   = document.getElementById('filterTo').value || null;
    loadActive();
  });
  document.getElementById('resetFilter').addEventListener('click', () => {
    document.getElementById('filterFrom').value = '';
    document.getElementById('filterTo').value = '';
    state.from = null;
    state.to = null;
    loadActive();
  });
  document.getElementById('exportCsv').addEventListener('click', exportCsv);

  // Load awal
  await loadActive();
})();

// ---------- Dispatch ----------
async function loadActive() {
  if (state.activeTab === 'tb') await loadTrialBalance();
  else if (state.activeTab === 'cf') await loadCashflow();
  else if (state.activeTab === 'ar') await loadAging();
}

// ---------- Trial Balance ----------
async function loadTrialBalance() {
  const tbody = document.getElementById('tbody-tb');
  const tfoot = document.getElementById('tfoot-tb');
  document.getElementById('tbPeriod').textContent = periodLabel(state.from, state.to);
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  try {
    const rows = await trialBalance({ from: state.from, to: state.to });
    let sumD = 0, sumC = 0;
    tbody.innerHTML = rows.map(r => {
      sumD += Number(r.total_debit);
      sumC += Number(r.total_credit);
      const badge = `<span class="badge-type badge-${r.type}">${r.type}</span>`;
      const balCls = r.balance < 0 ? 'neg' : (r.balance > 0 ? 'pos' : '');
      return `
        <tr>
          <td data-label="Kode">${esc(r.code)}</td>
          <td data-label="Nama">${esc(r.name)}</td>
          <td data-label="Tipe">${badge}</td>
          <td data-label="Debit" class="num">${fmt(r.total_debit)}</td>
          <td data-label="Kredit" class="num">${fmt(r.total_credit)}</td>
          <td data-label="Saldo" class="num ${balCls}">${fmt(r.balance)}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="6" style="text-align:center;color:#9ca3af;">Tidak ada data</td></tr>';

    tfoot.innerHTML = `
      <tr class="report-total">
        <td colspan="3">TOTAL</td>
        <td class="num">${fmt(sumD)}</td>
        <td class="num">${fmt(sumC)}</td>
        <td class="num">${fmt(sumD - sumC)}</td>
      </tr>`;

    state.lastData = { type: 'tb', rows };
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
    tfoot.innerHTML = '';
  }
}

// ---------- Cashflow ----------
async function loadCashflow() {
  const sumBody = document.getElementById('tbody-cf-summary');
  const detailBody = document.getElementById('tbody-cf-detail');
  document.getElementById('cfPeriod').textContent = periodLabel(state.from, state.to);
  sumBody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  detailBody.innerHTML = '';
  try {
    const { summary, rows } = await cashflow({ from: state.from, to: state.to });
    sumBody.innerHTML = summary.map(s => {
      const cls = s.net < 0 ? 'neg' : (s.net > 0 ? 'pos' : '');
      return `
        <tr>
          <td data-label="Kode">${esc(s.code)}</td>
          <td data-label="Akun">${esc(s.name)}</td>
          <td data-label="Masuk" class="num pos">${fmt(s.inflow)}</td>
          <td data-label="Keluar" class="num neg">${fmt(s.outflow)}</td>
          <td data-label="Net" class="num ${cls}">${fmt(s.net)}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="5" style="text-align:center;color:#9ca3af;">Tidak ada data</td></tr>';

    detailBody.innerHTML = rows.map(r => `
      <tr>
        <td data-label="Tanggal">${esc(r.journal_date)}</td>
        <td data-label="No">${esc(r.journal_no)}</td>
        <td data-label="Akun">${esc(r.account_code)} — ${esc(r.account_name)}</td>
        <td data-label="Deskripsi">${esc(r.description || '')}</td>
        <td data-label="Debit" class="num">${fmt(r.debit)}</td>
        <td data-label="Kredit" class="num">${fmt(r.credit)}</td>
      </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:#9ca3af;">Tidak ada mutasi</td></tr>';

    state.lastData = { type: 'cf', summary, rows };
  } catch (err) {
    sumBody.innerHTML = `<tr><td colspan="5" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

// ---------- Aging ----------
async function loadAging() {
  const tbody = document.getElementById('tbody-ar');
  const tfoot = document.getElementById('tfoot-ar');
  document.getElementById('arPeriod').textContent = `Per ${state.to || new Date().toISOString().slice(0, 10)}`;
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  try {
    const rows = await agingPiutang({ asOf: state.to || null });
    let t0 = 0, t31 = 0, t60 = 0, tAll = 0;
    tbody.innerHTML = rows.map(r => {
      t0 += r.b0_30; t31 += r.b31_60; t60 += r.b60p; tAll += r.total;
      return `
        <tr>
          <td data-label="Pelanggan">${esc(r.name)}</td>
          <td data-label="0-30" class="num">${fmt(r.b0_30)}</td>
          <td data-label="31-60" class="num">${fmt(r.b31_60)}</td>
          <td data-label="60+" class="num">${fmt(r.b60p)}</td>
          <td data-label="Total" class="num">${fmt(r.total)}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="5" style="text-align:center;color:#9ca3af;">Tidak ada piutang</td></tr>';

    tfoot.innerHTML = `
      <tr class="report-total">
        <td>TOTAL</td>
        <td class="num">${fmt(t0)}</td>
        <td class="num">${fmt(t31)}</td>
        <td class="num">${fmt(t60)}</td>
        <td class="num">${fmt(tAll)}</td>
      </tr>`;

    state.lastData = { type: 'ar', rows };
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
    tfoot.innerHTML = '';
  }
}

// ---------- Export CSV ----------
function exportCsv() {
  const d = state.lastData;
  if (!d) { toast('Tidak ada data untuk diexport', true); return; }

  let headers = [], rows = [], filename = '';
  if (d.type === 'tb') {
    filename = 'trial-balance';
    headers = ['Kode', 'Nama Akun', 'Tipe', 'Debit', 'Kredit', 'Saldo'];
    rows = d.rows.map(r => [r.code, r.name, r.type, r.total_debit, r.total_credit, r.balance]);
  } else if (d.type === 'cf') {
    filename = 'cashflow';
    headers = ['Tanggal', 'No. Jurnal', 'Akun', 'Deskripsi', 'Debit', 'Kredit'];
    rows = d.rows.map(r => [r.journal_date, r.journal_no, `${r.account_code} ${r.account_name}`, r.description, r.debit, r.credit]);
  } else if (d.type === 'ar') {
    filename = 'aging-piutang';
    headers = ['Pelanggan', '0-30', '31-60', '60+', 'Total'];
    rows = d.rows.map(r => [r.name, r.b0_30, r.b31_60, r.b60p, r.total]);
  }

  const escapeCsv = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [headers, ...rows].map(r => r.map(escapeCsv).join(',')).join('\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const period = `${state.from || 'all'}_${state.to || 'all'}`;
  a.href = url;
  a.download = `${filename}_${period}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('CSV berhasil diunduh');
}