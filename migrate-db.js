const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const { assertMaintenanceAccess } = require('./scripts/maintenance-guard');
if (assertMaintenanceAccess('legacy database migration', { write: true }).dryRun) process.exit(0);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function migrate() {
  const { data, error } = await supabase.rpc('query', { sql: 'ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;' });
  console.log("RPC Error:", error);
  
  // If no RPC for raw sql, let's try just selecting orders to see if it exists
  const { data: orders, error: checkErr } = await supabase.from('orders').select('expires_at').limit(1);
  console.log("Check:", checkErr);
}
migrate();
