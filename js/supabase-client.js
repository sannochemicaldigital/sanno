// js/supabase-client.js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://dqwzueaxphtcwnzvfxlp.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_jCnF2CdksyOoZJRNCn7xvw_Xle0RbZP';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.supabase = supabase;