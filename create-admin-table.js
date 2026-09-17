const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: './.env' });
const { assertMaintenanceAccess } = require('./scripts/maintenance-guard');
if (assertMaintenanceAccess('admin table creation', { write: true }).dryRun) process.exit(0);

async function createAdminsTable() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  
  const sql = `
    CREATE TABLE IF NOT EXISTS public.admins (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_2fa_enabled BOOLEAN DEFAULT false,
      two_factor_secret TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `;

  const { data, error } = await supabase.rpc('query', { sql });
  if (error) {
    console.error('Error creating admins table:', error);
  } else {
    console.log('Successfully created admins table:', data);
  }
}

createAdminsTable();
