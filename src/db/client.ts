import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';

/**
 * Server-side Supabase client using the service-role key.
 * Bypasses RLS — only ever run this on the backend.
 */
export const db: SupabaseClient = createClient(
  config.supabaseUrl,
  config.supabaseServiceKey,
  { auth: { persistSession: false } }
);
