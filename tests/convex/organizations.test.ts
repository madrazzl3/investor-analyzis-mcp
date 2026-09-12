// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, expect, it, vi } from 'vitest';
import schema from '../../convex/schema';
import { api } from '../../convex/_generated/api';
const modules = import.meta.glob('../../convex/**/*.{ts,js}');
afterEach(() => vi.unstubAllEnvs());
it('requires authentication and isolates idempotent personal workspaces', async () => {
  const t = convexTest(schema, modules);
  await expect(t.query(api.organizations.list, {})).rejects.toThrow(
    'Authentication required',
  );
  await expect(
    t.mutation(api.organizations.createPersonal, {}),
  ).rejects.toThrow('Authentication required');
  const alice = t.withIdentity({
    issuer: 'https://auth.invalid',
    subject: 'alice',
  });
  const bob = t.withIdentity({
    issuer: 'https://auth.invalid',
    subject: 'bob',
  });
  const organizationId = await alice.mutation(
    api.organizations.createPersonal,
    {},
  );
  expect(await alice.mutation(api.organizations.createPersonal, {})).toBe(
    organizationId,
  );
  expect(await bob.query(api.organizations.list, {})).toEqual([]);
  await expect(bob.query(api.cases.list, { organizationId })).rejects.toThrow(
    'Access denied',
  );
  expect(
    (await alice.query(api.organizations.list, {})).map((item) => item._id),
  ).toEqual([organizationId]);
});
it('keeps Convex Auth membership stable across sessions without normalizing external subjects', async () => {
  const issuer = 'https://example.convex.site';
  vi.stubEnv('CONVEX_SITE_URL', issuer);
  const t = convexTest(schema, modules);
  const first = t.withIdentity({ issuer, subject: 'user123|session1' });
  const second = t.withIdentity({ issuer, subject: 'user123|session2' });
  const organizationId = await first.mutation(
    api.organizations.createPersonal,
    {},
  );
  expect((await second.query(api.organizations.list, {}))[0]?._id).toBe(
    organizationId,
  );
  const external = t.withIdentity({
    issuer: 'https://external.invalid',
    subject: 'user123|session1',
  });
  expect(await external.query(api.organizations.list, {})).toEqual([]);
});
