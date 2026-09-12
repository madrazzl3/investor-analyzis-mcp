// Mechanical evidence checks shared by the step action and the publish mutation.
// They prove a quote was copied, not that it was read or interpreted correctly.

type Evidence = { documentVersionId: string; quote: string; page: unknown };

function evidenceItems(value: unknown, found: Evidence[] = []): Evidence[] {
  if (Array.isArray(value)) value.forEach((x) => evidenceItems(x, found));
  else if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    if (
      typeof item.documentVersionId === 'string' &&
      typeof item.quote === 'string'
    )
      found.push({
        documentVersionId: item.documentVersionId,
        quote: item.quote,
        page: item.page ?? null,
      });
    else Object.values(item).forEach((x) => evidenceItems(x, found));
  }
  return found;
}

/** Every source reference must name one of the run's frozen document versions. */
export function assertRunDocuments(
  value: unknown,
  allowed: readonly string[],
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((x) => assertRunDocuments(x, allowed));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'documentVersionId' &&
      (typeof child !== 'string' || !allowed.includes(child))
    )
      throw new Error('Foreign evidence reference');
    assertRunDocuments(child, allowed);
  }
}

/** Tolerates whitespace, case, and typographic quote/dash differences only. */
export function normalizeQuote(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * A step that cannot see documents may cite only evidence it was given: the
 * same document and page, and the same quote or a contiguous excerpt of it.
 */
export function assertEvidenceFromInputs(
  outputs: unknown,
  inputs: unknown,
): void {
  const given = evidenceItems(inputs).map((e) => ({
    ...e,
    quote: normalizeQuote(e.quote),
  }));
  for (const cited of evidenceItems(outputs)) {
    const quote = normalizeQuote(cited.quote);
    if (
      !quote ||
      !given.some(
        (e) =>
          e.documentVersionId === cited.documentVersionId &&
          e.page === cited.page &&
          e.quote.includes(quote),
      )
    )
      throw new Error('Evidence quote not found in step inputs');
  }
}

/** Quotes citing a plain-text source must occur in it. PDFs are not parsed here. */
export function assertQuotesInText(
  outputs: unknown,
  texts: ReadonlyMap<string, string>,
): void {
  const normalized = new Map(
    [...texts].map(([id, text]) => [id, normalizeQuote(text)]),
  );
  for (const cited of evidenceItems(outputs)) {
    const text = normalized.get(cited.documentVersionId);
    const quote = normalizeQuote(cited.quote);
    if (text !== undefined && (!quote || !text.includes(quote)))
      throw new Error('Evidence quote not found in source text');
  }
}
