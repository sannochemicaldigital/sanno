// js/reports-page.js
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { hasPermission } from './permissions.js';
import { trialBalance, cashflow, agingPiutang, labaRugi, neraca } from './reports.js';

const state = {
  from: null,
  to: null,
  activeTab: 'tb',
  lastData: null,
  perms: {}
};

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
function periodLabel(from, to) {
  if (!from && !to) return 'Semua periode';
  return `${from || '...'} s/d ${to || '...'}`;
}

(async () => {
  const user = await requireAuth();
  if (!user) return;

  const role = await requirePageAccess('reports');
  if (!role) return;

  document.getElementById('logoutBtn').addEventListener('click', logout);
  await renderNav(document.getElementById('mainNav'), 'reports');

  // Muat permission
  state.perms.export       = await hasPermission('reports.export');
  state.perms.periodSet    = await hasPermission('reports.period.set');
  state.perms.trialBalance = await hasPermission('reports.trial_balance');
  state.perms.cashflow     = await hasPermission('reports.cashflow');
  state.perms.aging        = await hasPermission('reports.aging_piutang');
  state.perms.labaRugi     = await hasPermission('reports.laba_rugi');
  state.perms.neraca       = await hasPermission('reports.neraca');

  if (!state.perms.export) document.getElementById('exportCsv').style.display = 'none';
  if (!state.perms.periodSet) {
    document.getElementById('applyFilter').disabled = true;
    document.getElementById('resetFilter').disabled = true;
  }

  // Sembunyikan tab yang tidak berhak
  const tabPerms = {
    tb: state.perms.trialBalance, cf: state.perms.cashflow,
    ar: state.perms.aging, lr: state.perms.labaRugi, nc: state.perms.neraca
  };
  let firstAllowed = null;
  Object.entries(tabPerms).forEach(([tab, ok]) => {
    const btn = document.querySelector(`.tabs button[data-tab="${tab}"]`);
    if (!ok && btn) btn.style.display = 'none';
    else if (ok && !firstAllowed) firstAllowed = tab;
  });

  // Default periode
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  document.getElementById('filterFrom').value = firstOfMonth.toISOString().slice(0, 10);
  document.getElementById('filterTo').value = today.toISOString().slice(0, 10);
  state.from = document.getElementById('filterFrom').value;
  state.to = document.getElementById('filterTo').value;

  // Aktifkan tab pertama yang berhak
  if (firstAllowed) {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
    document.querySelector(`.tabs button[data-tab="${firstAllowed}"]`).classList.add('active');
    document.getElementById('tab-' + firstAllowed).style.display = 'block';
    state.activeTab = firstAllowed;
  }

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

  await loadActive();
})();

async function loadActive() {
  if (state.activeTab === 'tb') await loadTrialBalance();
  else if (state.activeTab === 'cf') await loadCashflow();
  else if (state.activeTab === 'ar') await loadAging();
  else if (state.activeTab === 'lr') await loadLabaRugi();
  else if (state.activeTab === 'nc') await loadNeraca();
}

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

async function loadLabaRugi() {
  const tbody = document.getElementById('tbody-lr');
  document.getElementById('lrPeriod').textContent = periodLabel(state.from, state.to);
  tbody.innerHTML = '<tr><td style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  try {
    const r = await labaRugi({ from: state.from, to: state.to });
    const row = (label, val, cls = '') =>
      `<tr class="${cls}"><td>${esc(label)}</td><td class="num">${fmt(val)}</td></tr>`;
    const sectionTitle = t =>
      `<tr><td colspan="2" class="report-section-title">${esc(t)}</td></tr>`;

    let html = '';
    html += sectionTitle('Pendapatan');
    html += r.revenue.map(x => row(`${x.code} — ${x.name}`, x.balance)).join('');
    html += row('Total Pendapatan', r.totalRevenue, 'report-subtotal');
    html += sectionTitle('Harga Pokok Penjualan');
    html += r.hpp.map(x => row(`${x.code} — ${x.name}`, x.balance)).join('');
    html += row('Total HPP', r.totalHpp, 'report-subtotal');
    html += row('LABA KOTOR', r.grossProfit, 'report-grandtotal');
    html += sectionTitle('Beban Operasional');
    html += r.opex.map(x => row(`${x.code} — ${x.name}`, x.balance)).join('');
    html += row('Total Beban Operasional', r.totalOpex, 'report-subtotal');
    html += row('LABA OPERASIONAL', r.operatingProfit, 'report-grandtotal');
    if (r.otherExp.length) {
      html += sectionTitle('Beban Lain-lain');
      html += r.otherExp.map(x => row(`${x.code} — ${x.name}`, x.balance)).join('');
      html += row('Total Beban Lain-lain', r.totalOtherExp, 'report-subtotal');
    }
    html += row('LABA BERSIH', r.netProfit, 'report-grandtotal');
    tbody.innerHTML = html;
    state.lastData = { type: 'lr', data: r };
  } catch (err) {
    tbody.innerHTML = `<tr><td style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

async function loadNeraca() {
  const tbody = document.getElementById('tbody-nc');
  const status = document.getElementById('ncStatus');
  document.getElementById('ncPeriod').textContent = `Per ${state.to || new Date().toISOString().slice(0, 10)}`;
  tbody.innerHTML = '<tr><td style="text-align:center;color:#9ca3af;">Memuat...</td></tr>';
  status.innerHTML = '';
  try {
    const n = await neraca({ asOf: state.to || null });
    const row = (label, val, cls = '') =>
      `<tr class="${cls}"><td>${esc(label)}</td><td class="num">${fmt(val)}</td></tr>`;
    const sectionTitle = t =>
      `<tr><td colspan="2" class="report-section-title">${esc(t)}</td></tr>`;

    let html = '';
    html += sectionTitle('ASET');
    html += n.asset.map(x => row(`${x.code} — ${x.name}`, x.balance)).join('');
    html += row('TOTAL ASET', n.totalAsset, 'report-grandtotal');
    html += sectionTitle('LIABILITAS');
    html += n.liability.map(x => row(`${x.code} — ${x.name}`, x.balance)).join('');
    html += row('Total Liabilitas', n.totalLiability, 'report-subtotal');
    html += sectionTitle('EKUITAS');
    html += n.equity.map(x => row(`${x.code} — ${x.name}`, x.balance)).join('');
    html += row('Laba Tahun Berjalan', n.currentProfit);
    html += row('TOTAL EKUITAS', n.totalEquity, 'report-subtotal');
    html += row('TOTAL LIABILITAS + EKUITAS', n.totalLiability + n.totalEquity, 'report-grandtotal');
    tbody.innerHTML = html;

    status.innerHTML = n.balanced
      ? `<div class="balance-indicator ok">✓ Neraca Balance (Aset = Liabilitas + Ekuitas)</div>`
      : `<div class="balance-indicator bad">⚠ Neraca Tidak Balance: selisih ${fmt(n.totalAsset - (n.totalLiability + n.totalEquity))}</div>`;
    state.lastData = { type: 'nc', data: n };
  } catch (err) {
    tbody.innerHTML = `<tr><td style="color:#b91c1c;">${esc(err.message)}</td></tr>`;
  }
}

function exportCsv() {
  if (!state.perms.export) { toast('Tidak ada akses export', true); return; }
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
  } else if (d.type === 'lr') {
    filename = 'laba-rugi';
    headers = ['Keterangan', 'Nilai'];
    const r = d.data;
    rows = [
      ...r.revenue.map(x => [`Pendapatan: ${x.name}`, x.balance]),
      ['Total Pendapatan', r.totalRevenue],
      ...r.hpp.map(x => [`HPP: ${x.name}`, x.balance]),
      ['Total HPP', r.totalHpp],
      ['LABA KOTOR', r.grossProfit],
      ...r.opex.map(x => [`Beban: ${x.name}`, x.balance]),
      ['Total Beban Operasional', r.totalOpex],
      ['LABA OPERASIONAL', r.operatingProfit],
      ...r.otherExp.map(x => [`Beban Lain: ${x.name}`, x.balance]),
      ['LABA BERSIH', r.netProfit]
    ];
  } else if (d.type === 'nc') {
    filename = 'neraca';
    headers = ['Keterangan', 'Nilai'];
    const n = d.data;
    rows = [
      ...n.asset.map(x => [`Aset: ${x.name}`, x.balance]),
      ['TOTAL ASET', n.totalAsset],
      ...n.liability.map(x => [`Liabilitas: ${x.name}`, x.balance]),
      ['Total Liabilitas', n.totalLiability],
      ...n.equity.map(x => [`Ekuitas: ${x.name}`, x.balance]),
      ['Laba Tahun Berjalan', n.currentProfit],
      ['TOTAL EKUITAS', n.totalEquity],
      ['TOTAL LIABILITAS + EKUITAS', n.totalLiability + n.totalEquity]
    ];
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