// js/company.js
import { supabase } from './supabase-client.js';

// Ambil profil perusahaan (single-row)
export async function getCompanyProfile() {
  const { data, error } = await supabase
    .from('company_profile')
    .select('*')
    .eq('id', 1)
    .single();
  if (error) throw error;
  return data;
}

// Update profil perusahaan
export async function updateCompanyProfile(payload) {
  const { data: { session } } = await supabase.auth.getSession();
  const { data, error } = await supabase
    .from('company_profile')
    .update({
      name:    payload.name,
      address: payload.address || null,
      phone:   payload.phone   || null,
      email:   payload.email   || null,
      website: payload.website || null,
      logo_url: payload.logo_url || null,
      tax_id:  payload.tax_id  || null,
      notes:   payload.notes   || null,
      updated_at: new Date().toISOString(),
      updated_by: session?.user?.id ?? null
    })
    .eq('id', 1)
    .select()
    .single();
  if (error) throw error;
  return data;
}