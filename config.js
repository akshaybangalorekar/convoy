/* Where the Supabase transport points, if you use it.
 *
 * The anon key is meant to be public — it ships to every browser, and row-level security in
 * the database is what actually protects the data. What must never be here is the
 * service_role key, which bypasses all of it.
 *
 * Leave these empty to keep using the public MQTT relays. The switch in Help overrides
 * `kind` per phone, so the two can be compared on a real trip without rebuilding.
 */
window.ConvoyNetConfig = {
  kind: 'mqtt',                    // 'mqtt' or 'supabase'
  supabaseUrl: '',                 // https://YOUR-PROJECT.supabase.co
  supabaseKey: '',                 // the anon / publishable key
  // Web Push, for waking a phone with the app closed. Generate a pair with
  // `npx web-push generate-vapid-keys`; the private half goes in the Edge Function's
  // secrets, never here.
  vapidPublicKey: '',
};
