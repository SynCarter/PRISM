import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const isDemoOnly = import.meta.env.VITE_DEMO_ONLY === 'true';

const hasValidEnv = Boolean(supabaseUrl && supabasePublishableKey);

if (!hasValidEnv && !isDemoOnly) {
  console.warn(
    '[PRISM Supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY in environment variables.'
  );
}

// When Supabase env vars are missing or running in demo-only mode, safely provide a fallback client
export const supabase: SupabaseClient = hasValidEnv
  ? createClient(supabaseUrl, supabasePublishableKey)
  : createClient('https://placeholder-prism.supabase.co', 'placeholder-key');
