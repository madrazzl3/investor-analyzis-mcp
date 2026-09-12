import { describe, expect, it } from 'vitest';
import {
  PendingStart,
  selectCase,
  selectOrganization,
  visibleSelection,
} from '../../apps/web/src/workspace-state';

describe('web mode and case isolation', () => {
  it('never exposes private selections to demo and preserves them on return', () => {
    const privateState = {
      organizationId: 'private-org',
      caseId: 'private-case',
      runId: 'private-run',
    };
    expect(visibleSelection('demo', privateState)).toEqual({});
    expect(visibleSelection('workspace', privateState)).toEqual(privateState);
  });
  it('removes stale runs and cases when switching scope', () => {
    const privateState = {
      organizationId: 'org',
      caseId: 'case',
      runId: 'run',
    };
    expect(selectCase(privateState, 'other')).toEqual({
      organizationId: 'org',
      caseId: 'other',
    });
    expect(selectOrganization('other-org')).toEqual({
      organizationId: 'other-org',
    });
  });
  it('reuses start keys after ambiguous failures and separates cases', () => {
    const starts = new PendingStart();
    expect(starts.key('a', () => 'one')).toBe('one');
    expect(starts.key('a', () => 'two')).toBe('one');
    expect(starts.key('b', () => 'three')).toBe('three');
    starts.accepted('a');
    expect(starts.key('a', () => 'four')).toBe('four');
  });
});
