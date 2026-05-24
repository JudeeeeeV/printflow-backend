const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function testShop() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: shops, error } = await supabase.from('shops').select('id, name, pricing_matrix').limit(1);
  if (error) {
    console.error(error);
  } else {
    console.log(JSON.stringify(shops, null, 2));
  }
}
testShop();
