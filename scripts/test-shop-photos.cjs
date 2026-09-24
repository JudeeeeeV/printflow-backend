const { PGlite } = require('@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create table public.shops (id text primary key, name text);
      insert into public.shops values ('shop-a', 'Existing shop');
      create schema storage;
      create table storage.objects (bucket_id text, name text);
      alter table storage.objects enable row level security;
      grant usage on schema public, storage to anon, authenticated, service_role;
      grant all on public.shops, storage.objects to anon, authenticated, service_role;
      create policy legacy_allow_all on storage.objects for all using (true) with check (true);
      create policy legacy_shop_access on public.shops for all using (true) with check (true);
      insert into storage.objects values ('shop_photos', 'shop-a/photo.webp'), ('other_bucket', 'unrelated');
    `);
    const migration = readFileSync('supabase/migrations/20260924010000_shop_photos.sql', 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    assert.equal((await db.query('select shop_photo_path from public.shops')).rows[0].shop_photo_path, null);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(() => db.exec("update public.shops set shop_photo_path = 'other-shop/photo.webp'"), /permission denied/);
      await assert.rejects(() => db.exec("insert into storage.objects values ('shop_photos', 'forged.webp')"), /row-level security/);
      assert.equal((await db.query("select * from storage.objects where bucket_id = 'shop_photos'")).rows.length, 0);
      assert.equal((await db.query("update storage.objects set name = 'forged' where bucket_id = 'shop_photos' returning *")).rows.length, 0);
      assert.equal((await db.query("delete from storage.objects where bucket_id = 'shop_photos' returning *")).rows.length, 0);
      assert.equal((await db.query("select * from storage.objects where bucket_id = 'other_bucket'")).rows.length, 1);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    await db.exec("update public.shops set shop_photo_path = 'shop-a/photo.webp' where id = 'shop-a'");
    assert.equal((await db.query("select * from storage.objects where bucket_id = 'shop_photos'")).rows.length, 1);
    console.log('Shop photo migration passed: repeat application, existing shops preserved, direct browser writes/storage access blocked, backend access preserved.');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
