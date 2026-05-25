const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
  const { data, error } = await supabase.from('orders').select('id, state, created_at, expires_at').eq('state', 'AWAITING_PAYMENT');
  console.log("Error:", error);
  console.log("Data:", data);
}
check();
