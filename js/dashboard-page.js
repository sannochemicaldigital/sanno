// js/dashboard-page.js
import './input-clear.js';
import { requireAuth, logout } from './auth.js';
import { renderNav, requirePageAccess } from './access.js';
import { preloadPermissions, hasPermission } from './permissions.js';
import { dashboardBalances, bankBalanceSummary, plafonRkHutang } from './reports.js';
import { supabase } from './supabase-client.js';

// ============================================================
// UTIL
// ============================================================
const fmt = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const fmtShort = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 });
const fmtUsd = n => 'USD ' + Number(n || 0).toLocaleString('id-ID', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => el.className = 'toast', 2600);
}

// ============================================================
// INIT
// ============================================================
(async () => {
  try {
    const user = await requireAuth();
    if (!user) return;

    const [role] = await Promise.all([
      requirePageAccess('dashboard'),
      preloadPermissions()
    ]);
    if (!role) return;

    document.getElementById('logoutBtn').addEventListener('click', logout);
    document.getElementById('roleBadge').textContent = `(${role})`;

    await renderNav(document.getElementById('mainNav'), 'dashboard');

    const cards = document.getElementById('cards');
    cards.innerHTML = '<div style="color:#9ca3af;font-size:13px;">Memuat...</div>';

    if (role === 'gudang')       await renderGudangDashboard(cards);
    else if (role === 'sales')   await renderSalesDashboard(cards);
    else if (role === 'kasir')   await renderKasirDashboard(cards);
    else                         await renderFinanceDashboard(cards);
  } catch (err) {
    console.error('[dashboard init] error:', err);
    document.getElementById('cards').innerHTML = `
      <div class="card" style="grid-column:1/-1;">
        <div style="color:#b91c1c;font-size:13px;">
          Gagal memuat: <b>${esc(err.message || err)}</b>
        </div>
      </div>`;
  }
})();

// ============================================================
// GUDANG
// ============================================================
async function renderGudangDashboard(container) {
  const { data: items, error } = await supabase
    .from('items')
    .select('id, sku, name, unit, stock_qty, min_stock, is_active')
    .eq('is_active', true)
    .order('sku');
  if (error) throw error;

  const totalItems = items.length;
  const totalStok = items.reduce((s, i) => s + Number(i.stock_qty), 0);
  const lowStock = items.filter(i => Number(i.stock_qty) <= Number(i.min_stock));
  const outOfStock = items.filter(i => Number(i.stock_qty) === 0);

  container.innerHTML = `
    <div class="card">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">Total Item Aktif</div>
      <div style="font-size:22px;font-weight:600;">${totalItems}</div>
    </div>
    <div class="card">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">Total Qty Stok</div>
      <div style="font-size:22px;font-weight:600;">${totalStok.toLocaleString('id-ID')}</div>
    </div>
    <div class="card">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">Item di Bawah Min Stok</div>
      <div style="font-size:22px;font-weight:600;color:#b45309;">${lowStock.length}</div>
    </div>
    <div class="card">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">Item Stok Kosong</div>
      <div style="font-size:22px;font-weight:600;color:#b91c1c;">${outOfStock.length}</div>
    </div>`;

  if (await hasPermission('delivery.view')) {
    const { data: doPending } = await supabase
      .from('delivery_orders')
      .select('id')
      .eq('status', 'issued');
    container.innerHTML += `
      <div class="card">
        <div style="font-size:12px;color:#666;margin-bottom:6px;">DO Menunggu Dikirim</div>
        <div style="font-size:22px;font-weight:600;color:#b45309;">${(doPending || []).length}</div>
      </div>`;
  }

  if (lowStock.length) {
    container.innerHTML += `
      <div class="card" style="grid-column:1/-1;">
        <div style="font-size:14px;font-weight:600;margin-bottom:8px;">Item Perlu Restock</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>SKU</th><th>Nama</th><th>Stok</th><th>Min</th><th>Satuan</th></tr></thead>
            <tbody>
              ${lowStock.map(i => `
                <tr>
                  <td data-label="SKU">${esc(i.sku)}</td>
                  <td data-label="Nama">${esc(i.name)}</td>
                  <td data-label="Stok" style="color:${Number(i.stock_qty) === 0 ? '#b91c1c' : '#b45309'};font-weight:600;">${Number(i.stock_qty).toLocaleString('id-ID')}</td>
                  <td data-label="Min">${Number(i.min_stock).toLocaleString('id-ID')}</td>
                  <td data-label="Satuan">${esc(i.unit)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }
}

// ============================================================
// SALES
// ============================================================
async function renderSalesDashboard(container) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Session hilang');

  const { data: sos, error } = await supabase
    .from('sales_orders')
    .select('id, status, grand_total')
    .eq('sales_id', session.user.id);
  if (error) throw error;

  const count = s => sos.filter(so => so.status === s).length;
  const sum = s => sos.filter(so => so.status === s)
    .reduce((a, so) => a + Number(so.grand_total), 0);

  container.innerHTML = `
    <div class="card">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">SO Draft</div>
      <div style="font-size:22px;font-weight:600;">${count('draft')}</div>
    </div>
    <div class="card">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">SO Pending Approval</div>
      <div style="font-size:22px;font-weight:600;color:#b45309;">${count('pending_approval')}</div>
    </div>
    <div class="card">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">SO Approved</div>
      <div style="font-size:22px;font-weight:600;color:#059669;">${count('approved')}</div>
      <div style="font-size:12px;color:#666;margin-top:4px;">${fmt(sum('approved'))}</div>
    </div>
    <div class="card">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">SO Rejected</div>
      <div style="font-size:22px;font-weight:600;color:#b91c1c;">${count('rejected')}</div>
    </div>`;
}

// ============================================================
// KASIR
// ============================================================
async function renderKasirDashboard(container) {
  const { data: kas } = await supabase
    .from('v_account_balance')
    .select('balance')
    .eq('code', '1-1000')
    .single();
  const saldoKas = Number(kas?.balance || 0);

  const today = new Date().toISOString().slice(0, 10);
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Session hilang');

  const { data: cashToday, error } = await supabase
    .from('cash_sales')
    .select('id, grand_total')
    .eq('kasir_id', session.user.id)
    .eq('cash_date', today);

  const cashList = error ? [] : (cashToday || []);
  const totalCash = cashList.reduce((s, c) => s + Number(c.grand_total), 0);

  container.innerHTML = `
    <div class="card">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">Saldo Kas Fisik</div>
      <div style="font-size:22px;font-weight:600;">${fmt(saldoKas)}</div>
    </div>
    <div class="card">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">Transaksi Tunai Hari Ini</div>
      <div style="font-size:22px;font-weight:600;">${cashList.length}</div>
    </div>
    <div class="card">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">Total Tunai Hari Ini</div>
      <div style="font-size:22px;font-weight:600;">${fmt(totalCash)}</div>
    </div>`;
}

// ============================================================
// PIUTANG CARD — satu angka dari piutang_summary (historical_invoices)
// ============================================================
async function renderPiutangCard() {
  const { data: sum, error } = await supabase
    .from('piutang_summary')
    .select('*')
    .single();
  if (error) { console.warn('[piutang_summary] error:', error.message); return ''; }

  const saldo     = Number(sum?.total_sisa_idr || 0);
  const overdue   = Number(sum?.total_overdue_idr || 0);
  const countOpen = Number(sum?.count_open || 0);
  const countPaid = Number(sum?.count_paid || 0);
  const overdueColor = overdue > 0 ? '#b91c1c' : '#059669';

  return `
    <div class="card" style="border-left:4px solid #0891b2;">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">Piutang Dagang</div>
      <div style="font-size:22px;font-weight:700;color:#0891b2;">${fmtShort(saldo)}</div>
      <div style="font-size:11px;color:#6b7280;margin-top:6px;line-height:1.5;">
        ${countOpen} invoice terbuka · ${countPaid} lunas<br>
        Overdue: <strong style="color:${overdueColor};">${fmtShort(overdue)}</strong>
      </div>
    </div>`;
}

// ============================================================
// HUTANG CARD — konsolidasi (2-1100 IDR + 2-1101 USD + hutang_summary)
// ============================================================
async function renderHutangCard() {
  // 2-1100 = hutang dagang IDR, 2-1101 = hutang dagang USD (valas).
  // Saldo di v_account_balance sudah dalam IDR (debit_base/credit_base),
  // jadi penjumlahan sah untuk kartu total; rincian per mata uang tetap
  // ditampilkan supaya nilai USD tidak "hilang" seperti sebelumnya.
  const { data: acc, error: e1 } = await supabase
    .from('v_account_balance')
    .select('id, code, name, balance')
    .in('code', ['2-1100', '2-1101']);
  if (e1) { console.warn('[v_account_balance] hutang error:', e1.message); return ''; }

  // Coba ambil dari view hutang_summary (kalau sudah dibuat)
  const { data: sum } = await supabase
    .from('hutang_summary')
    .select('*')
    .maybeSingle();

  const row = code => (acc || []).find(a => a.code === code);
  const saldoIdr = Number(row('2-1100')?.balance || 0);
  const saldoUsd = Number(row('2-1101')?.balance || 0);   // setara IDR
  const saldo = saldoIdr + saldoUsd;

  // Nominal mata uang asli pada 2-1101 (baris jurnal berkurs USD)
  let usdNominal = null;
  const accUsd = row('2-1101');
  if (accUsd?.id && saldoUsd) {
    const { data: usdLines, error: e2 } = await supabase
      .from('journal_lines')
      .select('debit, credit, journals!inner(currency_code)')
      .eq('account_id', accUsd.id)
      .eq('journals.currency_code', 'USD');
    if (e2) console.warn('[journal_lines] nominal USD error:', e2.message);
    else usdNominal = (usdLines || [])
      .reduce((t, l) => t + Number(l.credit || 0) - Number(l.debit || 0), 0);
  }

  const overdue = Number(sum?.total_overdue_idr || 0);
  let countOpen = Number(sum?.count_open || 0);
  let countPaid = Number(sum?.count_paid || 0);

  // Kalau view hutang_summary belum ada di DB (sum null), jangan tampilkan
  // angka 0 palsu -> hitung langsung dari status invoice.
  if (!sum) {
    const { data: invStatus } = await supabase
      .from('purchase_invoices')
      .select('status');
    const rows = invStatus || [];
    countOpen = rows.filter(r => r.status === 'posted' || r.status === 'partial').length;
    countPaid = rows.filter(r => r.status === 'paid').length;
  }

  const overdueColor = overdue > 0 ? '#b91c1c' : '#059669';
  const rincian = saldoUsd
    ? ('IDR ' + fmtShort(saldoIdr) + ' · ' +
       (usdNominal === null
          ? 'USD setara ' + fmtShort(saldoUsd)
          : fmtUsd(usdNominal) + ' (setara ' + fmtShort(saldoUsd) + ')'))
    : '';
  const overdueHtml = sum
    ? `Overdue: <strong style="color:${overdueColor};">${fmtShort(overdue)}</strong>`
    : '';

  const info = [`${countOpen} invoice terbuka · ${countPaid} lunas`];
  if (rincian) info.push(rincian);
  if (overdueHtml) info.push(overdueHtml);

  return `
    <div class="card" style="border-left:4px solid #dc2626;">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">Hutang Dagang</div>
      <div style="font-size:22px;font-weight:700;color:#dc2626;">${fmtShort(saldo)}</div>
      <div style="font-size:11px;color:#6b7280;margin-top:6px;line-height:1.5;">
        ${info.join('<br>')}
      </div>
    </div>`;
}

// ============================================================
// SALDO BANK CARD — SATU kotak untuk SEMUA rekening bank (COA 1-11xx)
// ------------------------------------------------------------
// Sebelumnya dashboard hanya menampilkan 1 akun (dashboard_mapping 'bank'
// -> 1-1100 "Bank BCA"), sehingga CIMB IDR/USD dan OCBC tidak terlihat.
// Kartu ini menjumlahkan semua rekening dari bankBalanceSummary().
// ============================================================
async function renderBankCard() {
  const bukaKartu = isi => `
    <div class="card" style="border-left:4px solid #0891b2;grid-column:1/-1;">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">Saldo Bank</div>
      ${isi}
    </div>`;

  let ringkas;
  try {
    ringkas = await bankBalanceSummary();
  } catch (err) {
    console.warn('[dashboard] bankBalanceSummary:', err.message || err);
    return bukaKartu(`
      <div style="font-size:13px;color:#b91c1c;">
        Gagal memuat saldo bank: ${esc(err.message || err)}
      </div>`);
  }

  const items = ringkas.items || [];
  if (!items.length) {
    return bukaKartu(`
      <div style="font-size:13px;color:#9ca3af;">
        Belum ada akun bank aktif (COA 1-11xx) di bagan akun.
      </div>`);
  }

  const adaValas = items.some(i => i.currency !== 'IDR');
  // Akun plafon rekening koran (1-1110/1-1120/1-1130): saldo minusnya = HUTANG BANK,
  // jadi dikeluarkan dari angka aset dan ditampilkan terpisah (lihat kartu Hutang Bank).
  const totalAset  = Number(ringkas.bankTotal ?? ringkas.total ?? 0);
  const hutangRk   = Number(ringkas.hutangPlafon || 0);
  const totalNet   = Number(ringkas.total || 0);          // = totalAset - hutangRk
  const kodePlafon = items.filter(i => i.plafon).map(i => i.code).join(' / ');

  const baris = items.map(i => {
    const judul = i.bank_name || i.name;
    const noRek = i.account_no ? ` <span style="color:#9ca3af;">· ${esc(i.account_no)}</span>` : '';
    const valas = i.currency !== 'IDR'
      ? (i.amount_usd === null
          ? `<span style="color:#b45309;">${esc(i.currency)} (nominal belum ada)</span>`
          : `<span style="color:#6b7280;">${fmtUsd(i.amount_usd)}</span>`)
      : '';
    const warnaSaldo = i.balance < 0 ? '#b91c1c' : '#111827';
    const ket = i.plafon
      ? (i.hutang > 0
          ? `<span style="color:#b91c1c;font-weight:600;">Plafon RK · hutang</span>`
          : '<span style="color:#6b7280;">Plafon RK</span>')
      : '';
    return `
      <tr>
        <td data-label="Rekening">${esc(judul)}${noRek}</td>
        <td data-label="Akun" style="color:#6b7280;font-size:12px;">${esc(i.code)}</td>
        ${adaValas ? `<td data-label="Valas" style="color:#6b7280;font-size:12px;">${valas}</td>` : ''}
        <td data-label="Ket" style="font-size:11px;">${ket}</td>
        <td data-label="Saldo" style="text-align:right;font-weight:600;color:${warnaSaldo};">${fmt(i.balance)}</td>
      </tr>`;
  }).join('');

  const totalUsd = adaValas
    ? items.filter(i => i.currency === 'USD' && i.amount_usd !== null)
           .reduce((s, i) => s + i.amount_usd, 0)
    : 0;

  return bukaKartu(`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
      <div>
        <div style="font-size:11px;color:#6b7280;">Saldo bank (aset)</div>
        <div style="font-size:26px;font-weight:700;color:${totalAset < 0 ? '#b91c1c' : '#0891b2'};">${fmtShort(totalAset)}</div>
      </div>
      <div style="font-size:11px;color:#6b7280;text-align:right;line-height:1.6;">
        ${items.length} rekening · saldo buku besar (Rp)<br>
        ${totalUsd ? 'valas USD ' + Number(totalUsd).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '&nbsp;'}
        ${hutangRk > 0 ? `<br><span style="color:#b91c1c;font-weight:600;">Hutang bank — plafon RK: ${fmtShort(hutangRk)}</span>` : ''}
      </div>
    </div>
    <div class="table-wrap" style="margin-top:10px;">
      <table>
        <thead>
          <tr>
            <th>Rekening</th>
            <th>Akun</th>
            ${adaValas ? '<th>Valas</th>' : ''}
            <th>Ket</th>
            <th style="text-align:right;">Saldo (Rp)</th>
          </tr>
        </thead>
        <tbody>${baris}</tbody>
        <tfoot>
          <tr>
            <td colspan="${adaValas ? 4 : 3}" style="font-weight:600;">
              Saldo bersih${hutangRk > 0 ? ' (aset − hutang plafon RK)' : ''}
            </td>
            <td style="text-align:right;font-weight:700;color:${totalNet < 0 ? '#b91c1c' : '#0891b2'};">${fmt(totalNet)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    ${hutangRk > 0 ? `<div style="font-size:11px;color:#6b7280;margin-top:8px;line-height:1.5;">
      Saldo minus akun plafon rekening koran (${esc(kodePlafon)}) disajikan sebagai
      <strong style="color:#b91c1c;">Hutang Bank</strong> di kartu Hutang Bank — bukan aset bank.
    </div>` : ''}`);
}

// ============================================================
// HUTANG BANK CARD — akun 2-1000 + saldo minus akun plafon rekening koran
// ------------------------------------------------------------
// 1-1110 (CIMB IDR), 1-1120 (CIMB USD), 1-1130 (OCBC) adalah fasilitas
// plafon rekening koran. Saldo minus pada akun-akun itu = hutang ke bank,
// sehingga ditampilkan di sini (bukan sebagai aset di kartu Saldo Bank).
// ============================================================
async function renderHutangBankCard(saldoHutangBank) {
  const akunHutang = Number(saldoHutangBank || 0);

  let rk = { total: 0, items: [] };
  try {
    rk = await plafonRkHutang();
  } catch (err) {
    console.warn('[dashboard] plafonRkHutang:', err.message || err);
  }

  const hutangRk  = Number(rk.total || 0);
  const total     = akunHutang + hutangRk;
  const rincianRk = (rk.items || [])
    .filter(i => i.hutang > 0)
    .map(i => `${esc(i.name)} ${fmtShort(i.hutang)}`)
    .join(' · ');

  const info = [`Akun 2-1000: ${fmtShort(akunHutang)}`];
  if (hutangRk > 0) {
    info.push(`Plafon rekening koran: <strong style="color:#b91c1c;">${fmtShort(hutangRk)}</strong>`);
    if (rincianRk) info.push(`<span style="color:#9ca3af;">${rincianRk}</span>`);
    info.push('<span style="color:#9ca3af;">berasal dari saldo minus akun plafon RK</span>');
  }

  return `
    <div class="card" style="border-left:4px solid #dc2626;">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">Hutang Bank</div>
      <div style="font-size:22px;font-weight:700;color:#dc2626;">${fmtShort(total)}</div>
      <div style="font-size:11px;color:#6b7280;margin-top:6px;line-height:1.5;">
        ${info.join('<br>')}
      </div>
    </div>`;
}

// ============================================================
// FINANCE / SUPERVISOR / ADMIN / VIEWER
// ============================================================
async function saldoAkun(code) {
  const { data, error } = await supabase
    .from('v_account_balance')
    .select('balance')
    .eq('code', code)
    .maybeSingle();
  if (error) { console.warn('[v_account_balance] ' + code + ':', error.message); return 0; }
  return Number(data?.balance || 0);
}

async function renderFinanceDashboard(container) {
  const data = await dashboardBalances();
  const map = Object.fromEntries(data.map(d => [d.key, d]));

  const card = (label, val) => `
    <div class="card">
      <div style="font-size:12px;color:#666;margin-bottom:6px;">${label}</div>
      <div style="font-size:18px;font-weight:600;">${fmt(val)}</div>
    </div>`;

  const cards = [];

  if (await hasPermission('finance.cash.view')) {
    cards.push(card('Saldo Kas', map.kas?.balance));
  }
  if (await hasPermission('finance.bank.view')) {
    // Satu kartu untuk SEMUA rekening bank (BCA, CIMB IDR, CIMB USD, OCBC, ...)
    const bankHtml = await renderBankCard();
    if (bankHtml) cards.push(bankHtml);
  }
  if (await hasPermission('finance.piutang.view')) {
    const piutangHtml = await renderPiutangCard();
    if (piutangHtml) cards.push(piutangHtml);
    cards.push(card('Piutang Pihak Ketiga', map.piutang_pihak3?.balance));
  }
  if (await hasPermission('finance.hutang.view')) {
    // Hutang Bank = akun 2-1000 + saldo minus akun plafon rekening koran
    // (1-1110 / 1-1120 / 1-1130). Saldo minus itu tidak dihitung sebagai aset
    // di kartu Saldo Bank, jadi tidak ada angka dobel.
    cards.push(await renderHutangBankCard(map.hutang_bank?.balance));
    // Hutang Dagang — konsolidasi (2-1100 IDR + 2-1101 USD + hutang_summary)
    const hutangHtml = await renderHutangCard();
    if (hutangHtml) cards.push(hutangHtml);
    // dashboard_mapping belum punya baris 'hutang_pihak3' di seed SQL-02,
    // jadi kalau kosong ambil langsung akun 2-1110 (Hutang Pihak Ketiga).
    const pihak3 = map.hutang_pihak3?.balance ?? await saldoAkun('2-1110');
    cards.push(card('Hutang Pihak Ketiga', pihak3));
  }

  container.innerHTML = cards.length
    ? cards.join('')
    : '<div class="card" style="grid-column:1/-1;"><div style="color:#9ca3af;font-size:13px;">Tidak ada kartu yang ditampilkan sesuai hak akses.</div></div>';
}