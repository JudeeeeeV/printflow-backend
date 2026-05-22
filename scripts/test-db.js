const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function cleanOldOrders() {
  const { data, error } = await supabase
    .from('orders')
    .update({ state: 'PRINTED' })
    .in('id', [
      '2bc0a218-8290-4548-ae13-35d19bc31446',
      '5e27e40b-e36e-4da8-84c0-ff537aa032f1',
      'e5314deb-951d-4b84-bdbb-cf727e24ca34'
    ]);
    
  console.log('Cleaned old orders:', data, error);
}
cleanOldOrders();
