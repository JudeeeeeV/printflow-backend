const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcrypt');

require('dotenv').config({ path: './.env' });
const { assertMaintenanceAccess } = require('./scripts/maintenance-guard');
if (assertMaintenanceAccess('administrator seed', { write: true }).dryRun) process.exit(0);

async function seedAdmin() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || password.length < 12) {
    throw new Error(
      'SEED_ADMIN_EMAIL and a strong SEED_ADMIN_PASSWORD are required',
    );
  }
  const password_hash = await bcrypt.hash(password, 10);

  const { data, error } = await supabase
    .from('admins')
    .insert([{ email, password_hash, is_2fa_enabled: false }])
    .select();

  if (error) {
    if (error.code === '23505') {
      console.log('Admin already exists!');
    } else {
      console.error('Error inserting admin:', error);
    }
  } else {
    console.log('Successfully created default admin:', data);
  }
}

seedAdmin();
