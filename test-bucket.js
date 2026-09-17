require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { assertMaintenanceAccess } = require('./scripts/maintenance-guard');
if (assertMaintenanceAccess('bucket test', { write: true }).dryRun) process.exit(0);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function test() {
  const { data, error } = await supabase.storage.listBuckets();
  console.log("Buckets:", data, error);
  if (!data?.find(b => b.name === 'permits')) {
     const { data: createData, error: createError } = await supabase.storage.createBucket('permits', { public: false });
     console.log("Create Bucket:", createData, createError);
  }
}
test();
