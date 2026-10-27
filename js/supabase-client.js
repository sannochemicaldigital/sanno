// js/supabase-client.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ylssphgggpmirwiivbvw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_pgXl15Ax0p-0236hTxSGcw_nIJCHMY6';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.supabase = supabase;