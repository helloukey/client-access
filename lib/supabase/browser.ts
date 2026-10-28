"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Anon-key client used by the portal. Everything it can read is limited by RLS to the signed-in client.
let browser: SupabaseClient | undefined;

export function supabaseBrowser(): SupabaseClient {
  browser ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return browser;
}
