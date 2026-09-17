// Read-only access check; prints neither credentials nor table contents.
// Run from printflow-backend: node --env-file=.env scripts/check-rls-access.cjs
const { createClient } = require('@supabase/supabase-js');
const { assertMaintenanceAccess } = require('./maintenance-guard');

assertMaintenanceAccess('RLS access check');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase backend environment variables are missing.');
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (const table of ['admins', 'assets', 'notifications', 'orders', 'payment_receipts', 'shops', 'users']) {
    const { error, status } = await client.from(table).select('id').limit(0);
    console.log(JSON.stringify({ table, status, accessible: !error, error: error?.message }));
    if (error) process.exitCode = 1;
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
