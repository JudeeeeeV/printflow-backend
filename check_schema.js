const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkSchema() {
  const { error, status } = await supabase.from('shops').select('id').limit(0);
  console.log(
    JSON.stringify({ status, accessible: !error, error: error?.message }),
  );
}

checkSchema().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
