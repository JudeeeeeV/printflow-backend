const { PGlite } = require('@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create type public.user_role as enum ('STUDENT', 'CLERK', 'MANAGER');
      create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb);
      create table public.users (id uuid primary key references auth.users(id), email text not null, role public.user_role not null);
      create table public.shops (id uuid primary key, name text not null, status text, verification_status text, pricing_matrix jsonb not null);
    `);
    const migration = readFileSync('supabase/migrations/20260914_verify_before_signup.sql', 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    const scalar = async (sql, params = []) => Object.values((await db.query(sql, params)).rows[0])[0];
    const requestId = '12345678-1234-1234-1234-123456789abc';
    const email = 'otp@example.com';
    const reserve = () => scalar('select public.reserve_signup_code($1, $2, $3)', [email, requestId, 'correct-hash']);
    const consume = hash => scalar('select public.consume_signup_code($1, $2)', [email, hash]);
    const resetCooldown = () => db.exec("update printflow_private.signup_codes set resend_at = now() - interval '1 second'");
    assert.equal(await reserve(), 0);
    assert.equal(await scalar('select count(*)::int from auth.users'), 0);
    assert.equal(await scalar('select count(*)::int from public.users'), 0);
    assert.ok(await reserve() > 0, 'Resending respects cooldown');
    for (let i = 0; i < 5; i++) assert.equal(await consume('wrong'), false);
    assert.equal(await consume('correct-hash'), false, 'Five failed attempts lock the code');
    await resetCooldown();
    assert.equal(await reserve(), 0);
    assert.equal(await consume('correct-hash'), true);
    assert.equal(await consume('correct-hash'), false, 'A code cannot be reused');
    await resetCooldown();
    await reserve();
    await db.exec("update printflow_private.signup_codes set expires_at = now() - interval '1 second'");
    assert.equal(await consume('correct-hash'), false, 'Expired codes fail');
    await resetCooldown();
    await reserve();
    await db.query('select public.invalidate_signup_code($1, $2)', [email, requestId]);
    assert.equal(await consume('correct-hash'), false, 'Failed deliveries invalidate their code');
    await resetCooldown();
    await db.exec('update printflow_private.signup_codes set sent_count = 49');
    assert.equal(await reserve(), 0, 'The 50th email is still inside the legacy hourly limit');
    await resetCooldown();
    assert.ok(await reserve() > 60, 'Hourly limit persists across code consumption');
    await db.exec('set role authenticated');
    await assert.rejects(() => reserve(), /permission denied/);
    await assert.rejects(() => db.query('select * from printflow_private.signup_codes'), /permission denied/);
    await db.exec('reset role');
    await db.query(`insert into auth.users values ($1, $2, null, '{"signup_source":"printflow_email_otp","signup_role":"CLERK","signup_shop_name":"Example Shop"}', '{"role":"CLERK","shop_name":"Example Shop"}')`, [requestId, email]);
    await assert.rejects(() => db.query('select public.provision_verified_signup($1)', [requestId]), /Email must be verified/);
    await db.query('update auth.users set email_confirmed_at = now() where id = $1', [requestId]);
    await db.query('select public.provision_verified_signup($1)', [requestId]);
    assert.equal(await scalar('select count(*)::int from public.users'), 1);
    assert.equal(await scalar('select count(*)::int from public.shops'), 1);
    await db.exec("update public.users set role = 'MANAGER'; update public.shops set name = 'Updated shop'");
    await db.query('select public.provision_verified_signup($1)', [requestId]);
    assert.equal(await scalar('select role from public.users'), 'MANAGER');
    assert.equal(await scalar('select name from public.shops'), 'Updated shop');
    console.log('Migration checks passed: no premature accounts, cooldown, attempt limits, expiry, replay, delivery failure, permissions, provisioning and retries.');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
