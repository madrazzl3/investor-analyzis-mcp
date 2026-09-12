// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import workflowTest from '@convex-dev/workflow/test';
import { afterEach, expect, it, vi } from 'vitest';
import schema from '../../convex/schema';
import { api } from '../../convex/_generated/api';

// DEMO_OPEN_ACCESS lets anonymous callers act as one shared demo actor. It must
// stay off by default and never reach a signed-in user's workspace.
const modules = import.meta.glob('../../convex/**/*.{ts,js}');
afterEach(() => vi.unstubAllEnvs());

it('keeps anonymous access closed unless the deployment opts in', async () => {
  const t = convexTest(schema, modules);
  for (const value of [undefined, 'false', '1'] as const) {
    if (value !== undefined) vi.stubEnv('DEMO_OPEN_ACCESS', value);
    await expect(t.query(api.organizations.list, {})).rejects.toThrow(
      'Authentication required',
    );
    await expect(
      t.mutation(api.organizations.createPersonal, {}),
    ).rejects.toThrow('Authentication required');
  }
});

it('gives anonymous demo callers one shared, isolated workspace', async () => {
  const t = convexTest(schema, modules);
  workflowTest.register(t);
  const alice = t.withIdentity({
    issuer: 'https://auth.invalid',
    subject: 'alice',
  });
  const aliceOrg = await alice.mutation(api.organizations.createPersonal, {});
  const aliceCase = await alice.mutation(api.cases.create, {
    organizationId: aliceOrg,
    name: 'Private case',
  });

  vi.stubEnv('DEMO_OPEN_ACCESS', 'true');
  const demoOrg = await t.mutation(api.organizations.createPersonal, {});
  expect(await t.mutation(api.organizations.createPersonal, {})).toBe(demoOrg);
  expect(await t.query(api.organizations.list, {})).toMatchObject([
    { _id: demoOrg, name: 'Demo workspace', role: 'owner' },
  ]);

  // The demo actor uses the normal case/run API inside its own workspace.
  const caseId = await t.mutation(api.cases.create, {
    organizationId: demoOrg,
    name: 'Demo case',
  });
  const documentId = await t.mutation(api.cases.addSyntheticDocument, {
    caseId,
  });
  const runId = await t.mutation(api.runs.start, {
    caseId,
    requestId: 'demo-run',
    documentVersionIds: [documentId],
  });
  expect((await t.query(api.runs.get, { runId })).run.status).toBe('queued');

  // ...but is denied everything a signed-in user owns.
  await expect(
    t.query(api.cases.list, { organizationId: aliceOrg }),
  ).rejects.toThrow('Access denied');
  await expect(
    t.query(api.documents.list, { caseId: aliceCase }),
  ).rejects.toThrow('Access denied');
  await expect(
    t.mutation(api.cases.create, { organizationId: aliceOrg, name: 'x' }),
  ).rejects.toThrow('Access denied');

  // Signed-in users keep their own identity and never see the demo workspace.
  expect(
    (await alice.query(api.organizations.list, {})).map((o) => o._id),
  ).toEqual([aliceOrg]);
  await expect(alice.query(api.runs.get, { runId })).rejects.toThrow(
    'Access denied',
  );
});
