'use strict';

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });
const { assertMaintenanceAccess } = require('./maintenance-guard');

const maintenance = assertMaintenanceAccess('user and account-data cleanup', {
  write: true,
});
const execute = process.argv.includes('--execute');

if (!maintenance.dryRun && !execute) {
  throw new Error('Pass --dry-run to inspect or --execute to delete user data.');
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const applicationTables = [
  'notifications',
  'payment_receipts',
  'print_jobs',
  'assets',
  'orders',
  'daemon_devices',
  'shops',
  'users',
];

async function listAuthUsers() {
  const users = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 1000) return users;
  }
}

async function tableCount(table) {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function removeTableRows(table) {
  const { count, error } = await supabase
    .from(table)
    .delete({ count: 'exact' })
    .not('id', 'is', null);
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function main() {
  const authUsers = await listAuthUsers();
  const counts = {};
  for (const table of applicationTables) counts[table] = await tableCount(table);

  console.log(
    JSON.stringify(
      {
        project: maintenance.projectReference,
        mode: execute ? 'execute' : 'dry-run',
        authUsers: authUsers.length,
        applicationRows: counts,
      },
      null,
      2,
    ),
  );

  if (!execute) return;

  for (const table of applicationTables) {
    const removed = await removeTableRows(table);
    console.log(`Removed ${removed} row(s) from ${table}.`);
  }
  for (const user of authUsers) {
    const { error } = await supabase.auth.admin.deleteUser(user.id);
    if (error) throw new Error(`Auth user cleanup failed: ${error.message}`);
  }

  const remainingAuthUsers = await listAuthUsers();
  const remainingProfiles = await tableCount('users');
  if (remainingAuthUsers.length || remainingProfiles) {
    throw new Error('User cleanup verification failed.');
  }
  console.log('User cleanup complete: no Auth users or public profiles remain.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
