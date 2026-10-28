// js/settings.js
import { supabase } from './supabase-client.js';
import { getSetting } from './auth.js';

// Daftar setting yang bisa diatur admin
export const SETTING_DEFS = [
  {
    key: 'so_approval_mode',
    label: 'Mode Approval Sales Order',
    type: 'select',
    options: [
      { value: 'supervisor_only', label: 'Supervisor saja' },
      { value: 'finance_and_supervisor', label: 'Finance + Supervisor (paralel)' }
    ],
    help: 'Menentukan siapa yang harus approve SO sebelum DO terbit.'
  },
  {
    key: 'ppn_rate',
    label: 'Tarif PPN (%)',
    type: 'number',
    step: '0.01',
    help: 'Tarif PPN otomatis untuk penjualan kredit dan tunai.'
  },
  {
    key: 'delivery_by',
    label: 'Mark Delivered Oleh',
    type: 'select',
    options: [
      { value: 'gudang', label: 'Gudang' }
    ],
    help: 'Role yang bertanggung jawab menandai DO sebagai delivered.'
  }
];

export async function getAllSettings() {
  const { data, error } = await supabase
    .from('app_settings')
    .select('key, value, updated_at')
    .order('key');
  if (error) throw error;
  return Object.fromEntries(data.map(s => [s.key, s]));
}

export async function updateSetting(key, value) {
  const { data: { session } } = await supabase.auth.getSession();
  const { error } = await supabase
    .from('app_settings')
    .upsert({
      key,
      value: String(value),
      updated_by: session?.user?.id ?? null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'key' });
  if (error) throw error;
}