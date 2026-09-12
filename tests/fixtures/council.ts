const lensOf = (system: string) =>
  /You are the `([a-z-]+)` specialist/.exec(system)?.[1];

// Plausible council outputs. Later steps copy evidence from their inputs, as the
// prompts require; the mock never sees the documents either.
export function payload(
  port: string,
  inputs: Record<string, any>,
  system: string,
) {
  if (port === 'caseFile') {
    const id = (name: string) =>
      inputs.documents.find((d: { name: string }) => d.name === name)
        .documentVersionId;
    return {
      caseFile: {
        materialQuality: 'adequate',
        whatWeKnow: {
          companyName: 'Synthetic Co',
          product: 'Synthetic payroll software.',
          intendedUsers: null,
          businessModel: 'Subscription',
          stage: null,
        },
        claims: [
          {
            id: 'c1',
            topic: 'traction',
            text: 'ARR is $2.4M.',
            evidence: [
              {
                documentVersionId: id('deck.pdf'),
                quote: 'Annual recurring revenue of $2.4M',
                page: 3,
              },
            ],
          },
          {
            id: 'c2',
            topic: 'team',
            text: 'The founder discussed the company on a call.',
            evidence: [
              {
                documentVersionId: id('call.txt'),
                quote: 'founder  call',
                page: null,
              },
            ],
          },
        ],
        contradictionsAndGaps: [
          {
            id: 'g1',
            issue: 'No retention data.',
            source: 'Neither document gives cohort retention.',
            questionsForFounder: ['What is 12-month logo retention?'],
            evidence: [],
          },
        ],
        flags: { appearsToBeTest: true, other: [] },
        coverage: 'Both documents were read; charts were not interpreted.',
      },
    };
  }
  if (port === 'brief')
    return {
      brief: {
        contextBrief: 'Traction quality likely dominates this deal.',
        delegatedAgents: [
          'traction-authenticity',
          'financial-captable-fragility',
          'founder-team-integrity',
        ],
        whyTheseAgents: 'The only metric is ARR without retention.',
        dominantRiskType: 'traction',
        confidence: 'medium',
      },
    };
  const claim = inputs.caseFile.claims[0].evidence[0];
  const finding = (id: string, evidence: object[]) => ({
    id,
    title: 'ARR without retention',
    exploit: 'Churned customers are replaced by paid acquisition.',
    consequence: 'ARR overstates durable revenue.',
    investmentRisk: 'The valuation rests on unproven retention.',
    vrsd: { vector: 3, reachability: 3, severity: 4, detectability: 2 },
    pricedIn: 'unclear',
    precedentTag: 'fabricated-traction',
    source: 'c1, g1',
    evidence,
    alternativeExplanation: 'Retention may simply not have been shared yet.',
    founderQuestion: 'What is net revenue retention by cohort?',
  });
  if (port === 'assessment') {
    const lens = lensOf(system);
    if (lens === 'exit-return-under-downside')
      return {
        assessment: {
          abstained: true,
          abstentionReason: 'No valuation or terms in the material.',
          findings: [],
        },
      };
    // A contiguous excerpt of the case-file quote, on the same page.
    const excerpt = { ...claim, quote: 'recurring revenue of $2.4M' };
    return {
      assessment: {
        abstained: false,
        abstentionReason: '',
        findings: [finding(lens ? 'f1' : 'da1', lens ? [excerpt] : [])],
      },
    };
  }
  const top = inputs['traction-authenticity'].findings[0];
  return {
    report: {
      executiveSummary: 'Unproven retention behind the ARR headline.',
      overallRiskAssessment: 'medium',
      topFindings: [
        {
          rank: 1,
          lens: 'traction-authenticity',
          findingId: top.id,
          title: top.title,
          exploit: top.exploit,
          consequence: top.consequence,
          investmentRisk: top.investmentRisk,
          investorImplication: 'Verify cohort retention before relying on ARR.',
          vrsd: top.vrsd,
          pricedIn: top.pricedIn,
          evidence: top.evidence,
          alternativeExplanation: top.alternativeExplanation,
        },
      ],
      blindSpots: [],
      founderQuestions: [
        {
          question: 'What is 12-month logo retention?',
          context: 'ARR alone does not show durability.',
          findingIds: [top.id],
        },
      ],
      evidenceToRequest: ['Monthly revenue by customer'],
      coverage: 'Exit lens abstained. No precedent lookup was performed.',
    },
  };
}
