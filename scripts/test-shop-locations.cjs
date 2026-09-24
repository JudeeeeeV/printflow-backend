const { PGlite } = require('@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');

async function main() {
  const db = new PGlite();
  try {
    await db.exec("create table public.shops (id integer primary key, name text); insert into public.shops values (1, 'Existing shop');");
    const migration = readFileSync('supabase/migrations/20260924_shop_locations.sql', 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    const row = (await db.query('select * from public.shops where id = 1')).rows[0];
    assert.equal(row.name, 'Existing shop');
    assert.equal(row.latitude, null);
    assert.equal(row.longitude, null);
    for (const [lat, lng] of [[0, 0], [-90, -180], [90, 180], [10.3, 123.8], [null, null]]) {
      await db.query('update public.shops set latitude = $1, longitude = $2 where id = 1', [lat, lng]);
    }
    for (const [lat, lng] of [[10, null], [null, 120], [91, 120], [10, -181], [NaN, 120], [10, Infinity]]) {
      await assert.rejects(() => db.query('update public.shops set latitude = $1, longitude = $2 where id = 1', [lat, lng]), /shops_coordinates_valid/);
    }
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      grant all on public.shops to anon, authenticated, service_role;
      grant insert (latitude, longitude), update (latitude, longitude) on public.shops to public, anon, authenticated;
      create policy legacy_permissive_policy on public.shops for all using (true) with check (true);
    `);
    const security = readFileSync('supabase/migrations/20260924_shop_locations_security.sql', 'utf8');
    await db.exec(security);
    await db.exec(security);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(() => db.exec('update public.shops set latitude = 10, longitude = 120'), /permission denied/);
      await assert.rejects(() => db.exec('insert into public.shops (latitude, longitude) values (10, 120)'), /permission denied/);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    await db.exec('update public.shops set latitude = 10, longitude = 120 where id = 1');
    await db.exec('reset role');
    console.log('Shop location migrations passed: valid/invalid pins, repeat application, browser writes denied despite legacy grants/policies, backend access preserved.');
  } finally {
    await db.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
