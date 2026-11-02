// js/units.js
import { supabase } from './supabase-client.js';

// ============================================================
// LIST — semua unit aktif, urut sort_order
// ============================================================
export async function listUnits({ includeInactive = false } = {}) {
  let q = supabase.from('units')
    .select('id, code, name, sort_order, is_active, created_at')
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// ============================================================
// CREATE — tambah unit baru
// code: slug unik (mis. "drum200", "jerigen20"), tidak boleh ada spasi
// name: label tampil (mis. "Drum 200 L")
// ============================================================
export async function createUnit({ code, name, sort_order = 100 }) {
  const trimmedCode = String(code || '').trim().toLowerCase();
  const trimmedName = String(name || '').trim();
  if (!trimmedCode) throw new Error('Kode unit wajib diisi');
  if (!trimmedName) throw new Error('Nama unit wajib diisi');
  if (!/^[a-z0-9_]+$/.test(trimmedCode)) {
    throw new Error('Kode unit hanya boleh huruf kecil, angka, dan underscore');
  }

  const { data, error } = await supabase
    .from('units')
    .insert({ code: trimmedCode, name: trimmedName, sort_order: Number(sort_order) || 100 })
    .select('id, code, name, sort_order, is_active')
    .single();
  if (error) {
    // Tangani duplikat kode
    if (error.code === '23505') {
      throw new Error(`Kode unit "${trimmedCode}" sudah ada`);
    }
    throw error;
  }
  return data;
}

// ============================================================
// UPDATE — ubah nama / sort_order / is_active
// code TIDAK boleh diubah (karena dipakai referensi)
// ============================================================
export async function updateUnit(id, { name, sort_order, is_active }) {
  const patch = {};
  if (name !== undefined) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('Nama unit wajib diisi');
    patch.name = trimmed;
  }
  if (sort_order !== undefined) patch.sort_order = Number(sort_order) || 0;
  if (is_active !== undefined) patch.is_active = Boolean(is_active);

  if (Object.keys(patch).length === 0) return null;

  const { data, error } = await supabase
    .from('units')
    .update(patch)
    .eq('id', id)
    .select('id, code, name, sort_order, is_active')
    .single();
  if (error) throw error;
  return data;
}

// ============================================================
// DELETE — soft delete (set is_active = false)
// Hard delete tidak disarankan karena unit bisa dipakai item/price list
// ============================================================
export async function deleteUnit(id) {
  const { data, error } = await supabase
    .from('units')
    .update({ is_active: false })
    .eq('id', id)
    .select('id, code, name, is_active')
    .single();
  if (error) throw error;
  return data;
}

// ============================================================
// REACTIVATE — aktifkan kembali unit yang di-soft-delete
// ============================================================
export async function reactivateUnit(id) {
  const { data, error } = await supabase
    .from('units')
    .update({ is_active: true })
    .eq('id', id)
    .select('id, code, name, is_active')
    .single();
  if (error) throw error;
  return data;
}