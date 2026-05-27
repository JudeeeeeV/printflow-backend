const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const readline = require('readline');
const { spawn } = require('child_process');

// Load .env manually to avoid extra dependencies in raw scripts
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach(line => {
    const eqIdx = line.indexOf('=');
    if (eqIdx !== -1) {
      let key = line.slice(0, eqIdx).trim();
      // Remove any hidden BOM characters from the key
      key = key.replace(/^\uFEFF/, '');
      let val = line.slice(eqIdx + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
      process.env[key] = val;
    }
  });
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log("=========================================");
console.log("   Printflow Physical Daemon Login");
console.log("=========================================\n");

rl.question('Shop Email: ', (email) => {
  rl.question('Password: ', async (password) => {
    rl.close();
    
    console.log("\nAuthenticating...");
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password: password.trim(),
    });

    if (error) {
      console.error("❌ Login failed:", error.message);
      process.exit(1);
    }

    const shopId = data.user.id;
    console.log(`✅ Login successful!`);
    console.log(`ℹ️  Your retrieved Shop ID is: ${shopId}\n`);
    
    // Spawn the physical-daemon.js
    const daemonPath = path.join(__dirname, 'physical-daemon.js');
    console.log(`🚀 Starting physical daemon...\n`);
    
    const daemonProcess = spawn('node', [daemonPath, shopId], {
      stdio: 'inherit' // Routes all daemon logs directly to this terminal
    });

    daemonProcess.on('close', (code) => {
      console.log(`Daemon exited with code ${code}`);
      process.exit(code);
    });
  });
});
