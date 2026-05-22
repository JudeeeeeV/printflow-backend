import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://smelzqepvmqgwzlsdoes.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtZWx6cWVwdm1xZ3d6bHNkb2VzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTM2ODc3OCwiZXhwIjoyMDk0OTQ0Nzc4fQ.ChQu2VKtxJMTcOhNPUrRpbmdTseYkhgxZtNLrG9RqtA';
const supabase = createClient(supabaseUrl, supabaseKey);

async function checkSchema() {
    const { data, error } = await supabase
        .from('shops')
        .select('*')
        .limit(1);
        
    console.log("Shops Data:", JSON.stringify(data, null, 2));
    console.log("Error:", error);
}

checkSchema();

checkSchema();
