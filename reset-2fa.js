const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: './.env' });
const { assertMaintenanceAccess } = require('./scripts/maintenance-guard');
if (assertMaintenanceAccess('administrator 2FA reset', { write: true }).dryRun) process.exit(0);

async function reset2FA() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  const email = process.env.RESET_ADMIN_EMAIL;
  if (!email) throw new Error('RESET_ADMIN_EMAIL is required');

  console.log('Resetting 2FA for:', email);

  const { data, error } = await supabase
    .from('admins')
    .update({
      is_2fa_enabled: false,
      two_factor_secret: null,
      two_factor_secret_encrypted: null,
    })
    .eq('email', email)
    .select();

  if (error) {
    console.error('Error resetting 2FA:', error);
  } else {
    console.log('Successfully reset 2FA:', data);
  }
}

reset2FA();
