import { describe, expect, it } from 'vitest';
import {
  assertEvidenceFromInputs,
  assertQuotesInText,
  normalizeQuote,
} from '../../convex/analysis/evidence';

const caseFile = {
  claims: [
    {
      id: 'c1',
      evidence: [
        {
          documentVersionId: 'deck',
          quote: 'Annual recurring revenue of $2.4M',
          page: 3,
        },
      ],
    },
  ],
};
const cite = (quote: string, page: number | null = 3, doc = 'deck') => ({
  findings: [{ evidence: [{ documentVersionId: doc, quote, page }] }],
});

describe('evidence provenance', () => {
  it('accepts copied quotes and contiguous excerpts, tolerating whitespace and typography', () => {
    expect(normalizeQuote('  “ARR”\n –  $2.4M ')).toBe('"arr" - $2.4m');
    for (const quote of [
      'Annual recurring revenue of $2.4M',
      'recurring  revenue of $2.4m',
    ])
      expect(() =>
        assertEvidenceFromInputs(cite(quote), { caseFile }),
      ).not.toThrow();
    expect(() =>
      assertEvidenceFromInputs({ findings: [{ evidence: [] }] }, { caseFile }),
    ).not.toThrow();
  });

  it('rejects invented quotes, other pages, other documents, and blank quotes', () => {
    for (const output of [
      cite('Annual recurring revenue of $3.1M'),
      cite('Annual recurring revenue of $2.4M', 4),
      cite('Annual recurring revenue of $2.4M', null),
      cite('Annual recurring revenue of $2.4M', 3, 'call'),
      cite('   '),
    ])
      expect(() => assertEvidenceFromInputs(output, { caseFile })).toThrow(
        'not found in step inputs',
      );
  });

  it('checks quotes against plain-text sources only', () => {
    const texts = new Map([['call', 'Founder: we closed\n  twelve pilots.']]);
    expect(() =>
      assertQuotesInText(cite('closed twelve pilots', null, 'call'), texts),
    ).not.toThrow();
    expect(() =>
      assertQuotesInText(cite('closed forty pilots', null, 'call'), texts),
    ).toThrow('not found in source text');
    // PDFs are not parsed, so their quotes are not checked here.
    expect(() =>
      assertQuotesInText(cite('anything', 3, 'deck'), texts),
    ).not.toThrow();
  });
});
