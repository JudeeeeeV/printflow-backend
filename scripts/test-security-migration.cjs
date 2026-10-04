const { PGlite } = require('@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');

async function main() {
  const db = new PGlite();
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const scalar = async (sql, params = []) =>
    Object.values((await db.query(sql, params)).rows[0])[0];
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create table public.orders(id uuid primary key, state text, price integer);
      create table public.admins(id uuid primary key, is_2fa_enabled boolean not null default false,
        two_factor_secret text, two_factor_secret_encrypted text);
      create table public.admin_sessions(id uuid default gen_random_uuid() primary key,
        admin_id uuid not null references public.admins(id), token_id_hash text unique not null,
        expires_at timestamptz not null, revoked_at timestamptz);
    `);
    const migration = readFileSync(
      'supabase/migrations/20261005000000_security_remediation.sql',
      'utf8',
    );
    await db.exec(migration);
    await db.exec(migration);

    const orderId = randomUUID();
    await db.query(
      "insert into public.orders(id, state, price) values ($1, 'DRAFT', 10)",
      [orderId],
    );
    await db.query('update public.orders set price = 30 where id = $1', [
      orderId,
    ]);
    assert.equal(
      await scalar('select draft_version from public.orders where id = $1', [
        orderId,
      ]),
      1,
    );
    const submit = (version) =>
      db.query(
        "update public.orders set state = 'OPEN_INQUIRY' where id = $1 and state = 'DRAFT' and draft_version = $2 returning id",
        [orderId, version],
      );
    assert.equal(
      (await submit(0)).rows.length,
      0,
      'Stale pricing snapshots cannot submit',
    );
    await db.query(
      'update public.orders set price = 10, draft_version = 0 where id = $1',
      [orderId],
    );
    assert.equal(
      await scalar('select draft_version from public.orders where id = $1', [
        orderId,
      ]),
      2,
      'Even an ABA edit or explicit version reset increments the version',
    );
    assert.equal((await submit(0)).rows.length, 0);
    assert.equal((await submit(2)).rows.length, 1);
    assert.equal(
      (
        await db.query(
          "update public.orders set price = 99 where id = $1 and state = 'DRAFT' and draft_version = 2 returning id",
          [orderId],
        )
      ).rows.length,
      0,
      'Editing cannot win after submission',
    );

    const account = async (enabled = true, legacy = false) => {
      const id = randomUUID();
      await db.query(
        'insert into public.admins(id, is_2fa_enabled, two_factor_secret, two_factor_secret_encrypted) values ($1, $2, $3, $4)',
        [id, enabled, legacy ? 'seed' : null, legacy ? null : 'encrypted-seed'],
      );
      return id;
    };
    const challenge = async (id, setup = false) => {
      const value = hash(randomUUID());
      await db.query(
        "insert into public.admin_login_challenges(token_id_hash, admin_id, setup, expires_at) values ($1, $2, $3, now() + interval '15 minutes')",
        [value, id, setup],
      );
      return value;
    };
    const step = () =>
      scalar('select floor(extract(epoch from now()) / 30)::bigint');
    const reserve = (id, value) =>
      scalar('select public.reserve_admin_2fa_attempt($1, $2)', [id, value]);
    const complete = (
      id,
      value,
      counter,
      setup = false,
      expected = 'encrypted-seed',
      session = hash(randomUUID()),
    ) =>
      scalar(
        "select public.complete_admin_2fa($1, $2, $3, $4, $5, 'encrypted-seed', $6, now() + interval '1 hour')",
        [id, value, counter, setup, expected, session],
      );
    const id = await account();
    const value = await challenge(id);
    const counter = await step();
    assert.equal(
      await complete(id, value, counter),
      false,
      'Completion requires an attempt reservation',
    );
    assert.equal(
      await reserve(randomUUID(), value),
      false,
      'Challenges belong to their administrator',
    );
    assert.equal(await reserve(id, value), true);
    assert.equal(
      await complete(id, value, counter, true),
      false,
      'Enrollment cannot replace an enabled account',
    );
    assert.equal(
      await complete(id, value, counter, false, 'stale-seed'),
      false,
      'Changing the seed invalidates the verification snapshot',
    );
    assert.equal(
      await complete(id, value, counter - 2),
      false,
      'Old OTPs fail',
    );
    assert.equal(
      await complete(id, value, counter + 2),
      false,
      'Future OTPs outside the window fail',
    );
    assert.equal(await complete(id, value, counter), true);
    assert.equal(
      await reserve(id, value),
      false,
      'A consumed challenge cannot reserve another attempt',
    );
    assert.equal(
      await complete(id, value, counter),
      false,
      'A challenge cannot create two sessions',
    );
    assert.equal(
      await scalar(
        "select expires_at <= now() + interval '15 minutes' from public.admin_sessions where admin_id = $1",
        [id],
      ),
      true,
    );
    const replay = await challenge(id);
    await reserve(id, replay);
    assert.equal(
      await complete(id, replay, counter),
      false,
      'The same OTP cannot be reused with a new password challenge',
    );

    const competing = await account();
    const a = await challenge(competing),
      b = await challenge(competing);
    await reserve(competing, a);
    await reserve(competing, b);
    const results = await Promise.all([
      complete(competing, a, await step()),
      complete(competing, b, await step()),
    ]);
    assert.equal(
      results.filter(Boolean).length,
      1,
      'Competing completions have one winner',
    );
    assert.equal(
      await scalar(
        'select count(*)::int from public.admin_sessions where admin_id = $1',
        [competing],
      ),
      1,
    );

    const locked = await challenge(id);
    for (let i = 0; i < 5; i++) assert.equal(await reserve(id, locked), true);
    assert.equal(
      await reserve(id, locked),
      false,
      'Attempts are capped at five',
    );
    const expired = await challenge(id);
    await reserve(id, expired);
    await db.query(
      "update public.admin_login_challenges set expires_at = now() - interval '1 second' where token_id_hash = $1",
      [expired],
    );
    assert.equal(await reserve(id, expired), false);
    assert.equal(await complete(id, expired, await step()), false);

    const enrolling = await account(false, true);
    const setup = await challenge(enrolling, true);
    await reserve(enrolling, setup);
    assert.equal(
      await complete(enrolling, setup, await step(), true, 'seed'),
      true,
    );
    const row = (
      await db.query('select * from public.admins where id = $1', [enrolling])
    ).rows[0];
    assert.equal(row.is_2fa_enabled, true);
    assert.equal(row.two_factor_secret, null);
    assert.equal(row.two_factor_secret_encrypted, 'encrypted-seed');

    const rollbackId = await account();
    const rollback = await challenge(rollbackId);
    await reserve(rollbackId, rollback);
    const duplicateSession = await scalar(
      'select token_id_hash from public.admin_sessions limit 1',
    );
    await assert.rejects(
      () =>
        complete(
          rollbackId,
          rollback,
          counter,
          false,
          'encrypted-seed',
          duplicateSession,
        ),
      /duplicate key/,
    );
    assert.equal(
      await scalar('select last_totp_step from public.admins where id = $1', [
        rollbackId,
      ]),
      null,
      'Session errors roll back OTP consumption',
    );
    assert.equal(
      await scalar(
        'select consumed_at from public.admin_login_challenges where token_id_hash = $1',
        [rollback],
      ),
      null,
    );
    assert.equal(
      await complete(rollbackId, rollback, await step()),
      true,
      'A failed transaction remains retryable',
    );

    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(() => reserve(id, value), /permission denied/);
      await assert.rejects(
        () => complete(id, value, counter),
        /permission denied/,
      );
      await assert.rejects(
        () => db.query('select * from public.admin_login_challenges'),
        /permission denied/,
      );
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    assert.equal(
      await reserve(id, value),
      false,
      'Only the service role may invoke authentication RPCs',
    );
    await db.exec('reset role');
    console.log(
      'Security migration checks passed: version conflicts, OTP/challenge replay, enrollment, attempt limits, expiry, competing transactions, rollback, permissions and idempotency.',
    );
  } finally {
    await db.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
