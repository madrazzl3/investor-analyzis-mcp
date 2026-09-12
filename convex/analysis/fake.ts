// Deliberately synthetic. No files, model credentials, or external APIs are used.
export function fakeOutput(
  agentId: string,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  const documents = inputs.documents as
    { documentVersionId: string; name: string }[] | undefined;
  if (agentId === 'extract-claims')
    return {
      claims: [
        {
          id: 'synthetic-claim',
          text: 'Synthetic claim for execution testing only.',
          evidence: [
            {
              documentVersionId: documents![0]!.documentVersionId,
              quote: 'Synthetic fixture quote; no document was analyzed.',
              page: 1,
            },
          ],
        },
      ],
    };
  if (agentId === 'check-consistency') {
    const claims = inputs.claims as { evidence: unknown }[];
    return {
      findings: [
        {
          id: 'synthetic-finding',
          statement: 'Synthetic candidate discrepancy.',
          severity: 'low',
          evidence: claims[0]!.evidence,
          alternativeExplanation:
            'This is test data, not a diligence conclusion.',
        },
      ],
    };
  }
  if (agentId === 'verify-findings')
    return {
      verifiedFindings: {
        findings: (inputs.findings as object[]).map((f) => ({
          ...f,
          disposition: 'unresolved',
        })),
        coverage:
          'Synthetic workflow test only. No investor documents analyzed.',
      },
    };
  if (agentId === 'write-report')
    return {
      report: {
        summary: 'Synthetic workflow report — not investment analysis.',
        ...(inputs.verifiedFindings as object),
      },
    };
  throw new Error('No fake handler for this agent');
}
