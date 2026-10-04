const { PGlite } = require('@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create type public.user_role as enum ('STUDENT', 'CLERK', 'MANAGER');
      create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb);
      create table public.users (id uuid primary key, email text, role public.user_role);
      create table public.shops (id uuid primary key, name text, status text, verification_status text, pricing_matrix jsonb);
      insert into auth.users values ('00000000-0000-0000-0000-000000000001', 'juan.delacruz@cit.edu', now(), '{"provider":"azure"}', '{}');
      insert into public.users values ('00000000-0000-0000-0000-000000000001', 'juan.delacruz@cit.edu', 'MANAGER');
    `);
    // Exercise replacement of the existing email-confirmation trigger as well
    // as repeat application of the new migration.
    await db.exec(readFileSync('supabase/migrations/20260914_supabase_auth_trigger_v2.sql', 'utf8'));
    const migration = readFileSync('supabase/migrations/20261004010000_client_names.sql', 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    const profile = async (id) => (await db.query('select first_name, last_name, role from public.users where id = $1', [id])).rows[0];
    assert.deepEqual(await profile('00000000-0000-0000-0000-000000000001'), { first_name: 'Juan', last_name: 'Delacruz', role: 'MANAGER' });
    const id = '00000000-0000-0000-0000-000000000002';
    await db.query(`insert into auth.users values ($1, 'personal@example.com', null, '{"provider":"email"}', '{"first_name":" Maria Ana ","last_name":"De la Cruz", "role":"CLERK", "shop_name":"Maria Print"}')`, [id]);
    assert.equal(await profile(id), undefined, 'Unverified signups have no public profile');
    await db.query('update auth.users set email_confirmed_at = now() where id = $1', [id]);
    assert.deepEqual(await profile(id), { first_name: 'Maria Ana', last_name: 'De la Cruz', role: 'CLERK' });
    assert.equal((await db.query('select name from public.shops where id = $1', [id])).rows[0].name, 'Maria Print');
    const oauthId = '00000000-0000-0000-0000-000000000003';
    await db.query(`insert into auth.users values ($1, 'ANA.MARIE.SANTOS@cit.edu', now(), '{"provider":"azure"}', '{"role":"CLERK"}')`, [oauthId]);
    assert.deepEqual(await profile(oauthId), { first_name: 'Ana Marie', last_name: 'Santos', role: 'STUDENT' });
    await db.exec(migration);
    assert.deepEqual(await profile(id), { first_name: 'Maria Ana', last_name: 'De la Cruz', role: 'CLERK' });
    for (const email of ['student@cit.edu', 'juan..santos@cit.edu', 'juan.santos@example.com']) {
      assert.deepEqual((await db.query(`select * from public.registration_name($1, '{"provider":"azure"}', '{}')`, [email])).rows[0], { first_name: null, last_name: null });
    }
    const studentId = '00000000-0000-0000-0000-000000000004';
    await db.query(`insert into auth.users values ($1, 'student@example.com', null, '{"provider":"email"}', '{"first_name":"Ana", "last_name":"Cruz", "role":"STUDENT"}')`, [studentId]);
    assert.equal(await profile(studentId), undefined);
    // Resending a code or a failed verification must not provision a profile.
    await db.query('update auth.users set raw_user_meta_data = raw_user_meta_data where id = $1', [studentId]);
    assert.equal(await profile(studentId), undefined);
    await db.query('update auth.users set email_confirmed_at = now() where id = $1', [studentId]);
    assert.deepEqual(await profile(studentId), { first_name: 'Ana', last_name: 'Cruz', role: 'STUDENT' });
    assert.equal((await db.query('select * from public.shops where id = $1', [studentId])).rows.length, 0);
    await db.query("update public.users set first_name = 'Ana Maria', last_name = 'Santos' where id = $1", [studentId]);
    await db.exec('alter table auth.users add column encrypted_password text');
    // Password recovery updates the existing Auth user, not its saved name.
    await db.query("update auth.users set encrypted_password = 'test-password-hash' where id = $1", [studentId]);
    await db.query('update auth.users set email_confirmed_at = now() where id = $1', [studentId]);
    await db.exec(migration);
    assert.deepEqual(await profile(studentId), { first_name: 'Ana Maria', last_name: 'Santos', role: 'STUDENT' });
    assert.equal((await db.query('select count(*)::int as count from public.users where id = $1', [studentId])).rows[0].count, 1);
    console.log('Client name migration passed: trigger upgrade, backfill, repeat application, verified student/shop registration, no premature profiles, password recovery, edited-name preservation, OAuth roles and invalid formats.');
  } finally { await db.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
