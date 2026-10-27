// test.js
import { login, createJournal, dashboardBalances, listAccounts } from './app.js';

(async () => {
  try {
    // ✅ Ganti dengan akun Anda yang sebenarnya
    await login('sannochemical@gmail.com', 'KATA_SANDI_BARU_ANDA');
    console.log('Login sukses');

    const acc = {};
    (await listAccounts()).forEach(a => acc[a.code] = a.id);
    console.log('Akun:', Object.keys(acc).length);

    // 1. Modal awal 50jt
    await createJournal({
      journal_date: '2026-01-01',
      description: 'Setoran modal awal',
      lines: [
        { account_id: acc['1-1100'], debit: 50_000_000 },
        { account_id: acc['3-1000'], credit: 50_000_000 }
      ]
    });
    console.log('✅ Jurnal 1 (modal)');

    // 2. Beli barang kredit 10jt + PPN 11%
    await createJournal({
      journal_date: '2026-01-05',
      description: 'Beli barang kredit + PPN',
      lines: [
        { account_id: acc['1-1300'], debit: 10_000_000 },
        { account_id: acc['1-1400'], debit: 1_100_000, tax_code: 'PPN11' },
        { account_id: acc['2-1100'], credit: 11_100_000 }
      ]
    });
    console.log('✅ Jurnal 2 (beli kredit)');

    // 3. Jual tunai 5jt + PPN 11%, HPP 3jt
    await createJournal({
      journal_date: '2026-01-10',
      description: 'Penjualan tunai + HPP',
      lines: [
        { account_id: acc['1-1000'], debit: 5_550_000 },
        { account_id: acc['4-1000'], credit: 5_000_000 },
        { account_id: acc['2-1300'], credit: 550_000, tax_code: 'PPN11' },
        { account_id: acc['5-1000'], debit: 3_000_000 },
        { account_id: acc['1-1300'], credit: 3_000_000 }
      ]
    });
    console.log('✅ Jurnal 3 (jual tunai)');

    // 4. Bayar hutang via BCA 4jt
    await createJournal({
      journal_date: '2026-01-15',
      description: 'Pelunasan hutang dagang',
      lines: [
        { account_id: acc['2-1100'], debit: 4_000_000 },
        { account_id: acc['1-1100'], credit: 4_000_000 }
      ]
    });
    console.log('✅ Jurnal 4 (bayar hutang)');

    // 5. Pinjaman bank 20jt
    await createJournal({
      journal_date: '2026-01-20',
      description: 'Pencairan kredit modal kerja',
      lines: [
        { account_id: acc['1-1100'], debit: 20_000_000 },
        { account_id: acc['2-1000'], credit: 20_000_000 }
      ]
    });
    console.log('✅ Jurnal 5 (pinjaman bank)');

    console.log('=== DASHBOARD ===');
    console.table(await dashboardBalances());
  } catch (err) {
    console.error('❌ Error:', err.message || err);
    if (err.details) console.error('Details:', err.details);
    if (err.hint) console.error('Hint:', err.hint);
  }
})();