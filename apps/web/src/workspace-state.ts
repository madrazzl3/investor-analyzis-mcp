/** Keep private selections separate from the public demo; never persist evidence in browser storage. */
export type WorkspaceSelection = {
  organizationId?: string;
  caseId?: string;
  runId?: string;
};
export function selectOrganization(organizationId: string): WorkspaceSelection {
  return { organizationId };
}
export function selectCase(
  current: WorkspaceSelection,
  caseId: string,
): WorkspaceSelection {
  return { organizationId: current.organizationId, caseId };
}
export function visibleSelection(
  mode: 'demo' | 'workspace',
  current: WorkspaceSelection,
): WorkspaceSelection {
  return mode === 'demo' ? {} : { ...current };
}
/** Retain one key across ambiguous failures until a start is acknowledged. */
export class PendingStart {
  private requests = new Map<string, string>();
  key(caseId: string, newId: () => string): string {
    const existing = this.requests.get(caseId);
    if (existing) return existing;
    const next = newId();
    this.requests.set(caseId, next);
    return next;
  }
  accepted(caseId: string) {
    this.requests.delete(caseId);
  }
}
