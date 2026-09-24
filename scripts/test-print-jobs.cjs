const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');

async function main() {
  const db = new PGlite();
  const orderId = '11111111-1111-4111-8111-111111111111';
  const shopId = '22222222-2222-4222-8222-222222222222';
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create role service_role bypassrls;
      create table public.shops (id uuid primary key);
      create table public.orders (id uuid primary key);
      insert into public.shops values ('${shopId}');
      insert into public.orders values ('${orderId}');
    `);
    const migration = readFileSync('supabase/migrations/20260924020000_print_jobs.sql', 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    await db.exec('set role service_role');
    const claim = `insert into public.print_jobs (order_id, shop_id, status) values ('${orderId}', '${shopId}', 'QUEUED')`;
    await db.exec(claim);
    await assert.rejects(() => db.exec(claim), /duplicate key/);
    await db.exec("update public.print_jobs set status = 'FAILED'");
    await db.exec(claim);
    assert.equal((await db.query('select count(*)::int as count from public.print_jobs')).rows[0].count, 2);
    await db.exec('reset role');
    await db.exec(migration);
    assert.equal((await db.query('select count(*)::int as count from public.print_jobs')).rows[0].count, 2);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(() => db.query('select * from public.print_jobs'), /permission denied/);
      await assert.rejects(() => db.exec(claim), /permission denied/);
      await db.exec('reset role');
    }
    console.log('Print job migration passed: repeat application, backend claims, duplicate protection, retries, preserved records and browser access denial.');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
