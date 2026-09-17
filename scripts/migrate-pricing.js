const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { assertMaintenanceAccess } = require('./maintenance-guard');
if (assertMaintenanceAccess('pricing migration', { write: true }).dryRun) process.exit(0);

async function seedPricing() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const defaultMatrix = {
    paper_sizes: { "SHORT": 2.00, "A4": 3.00, "LONG": 4.00 },
    color_mode_multipliers: { "BLACK_AND_WHITE": 0.00, "COLOR": 3.00 }
  };

  const { data: shops, error: fetchError } = await supabase.from('shops').select('id, pricing_matrix');
  if (fetchError) {
    console.error("Error fetching shops:", fetchError);
    return;
  }

  for (const shop of shops) {
    console.log(`Updating pricing for shop ${shop.id}...`);
    const { error: updateError } = await supabase.from('shops').update({ pricing_matrix: defaultMatrix }).eq('id', shop.id);
    if (updateError) console.error("Error updating shop:", updateError);
  }
  console.log("Seeding complete.");
}

seedPricing();
