require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { assertMaintenanceAccess } = require('./scripts/maintenance-guard');
if (assertMaintenanceAccess('upload test', { write: true }).dryRun) process.exit(0);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function test() {
  const { data, error } = await supabase.storage.from('permits').upload('test.txt', 'hello world', { contentType: 'text/plain' });
  console.log("Upload:", data, error);
}
test();
