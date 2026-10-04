import { type Issue, issue } from '../../domain/issues.js';
import { PROTECTED_MARKS, type ProtectedMark } from './registry.js';
import { containsPhrase, editDistance, normalize, tokens } from './text.js';

export type MatchKind = 'name' | 'variant' | 'slogan';

export interface MarkMatch {
  markId: string;
  owner: string;
  /** The registry term that matched (normalised). */
  term: string;
  /** The word(s) found in the artwork (normalised). */
  found: string;
  kind: MatchKind;
  ambiguous: boolean;
}

/** Fuzzy matching only for longer names; "nike" vs "bike" must not match. */
const MIN_FUZZY_LENGTH = 5;

function matchName(words: string[], text: string, term: string): { found: string; kind: MatchKind } | null {
  if (term.includes(' ')) return containsPhrase(text, term) ? { found: term, kind: 'name' } : null;
  for (const w of words) {
    if (w === term || w === `${term}s`) return { found: w, kind: 'name' };
  }
  if (term.length >= MIN_FUZZY_LENGTH) {
    for (const w of words) {
      if (editDistance(w, term, 1) <= 1) return { found: w, kind: 'variant' };
    }
  }
  return null;
}

function matchMark(mark: ProtectedMark, words: string[], text: string): MarkMatch[] {
  const out: MarkMatch[] = [];
  const base = { markId: mark.id, owner: mark.owner };
  for (const term of mark.names) {
    const m = matchName(words, text, term);
    if (m) out.push({ ...base, term, ...m, ambiguous: false });
  }
  for (const term of mark.ambiguousNames) {
    const m = matchName(words, text, term);
    if (m) out.push({ ...base, term, ...m, ambiguous: true });
  }
  for (const slogan of mark.slogans) {
    if (containsPhrase(text, slogan)) out.push({ ...base, term: slogan, found: slogan, kind: 'slogan', ambiguous: false });
  }
  return out;
}

export interface ProtectedMarkResult {
  matches: MarkMatch[];
  issues: Issue[];
}

/**
 * Checks text found on the artwork against the protected-mark registry.
 *
 * - Clear brand names and slogans: PROTECTED_MARK (CRITICAL), not OK to produce.
 * - Same, but the ticket carries a licence reference: LICENSED_MARK (WARNING),
 *   because a person has to verify the licence.
 * - Brand names that are also everyday words: AMBIGUOUS_MARK (WARNING).
 */
export function matchProtectedMarks(texts: string[], opts: { licenceReference?: string | undefined } = {}): ProtectedMarkResult {
  const text = normalize(texts.join(' \n '));
  const words = tokens(text);
  const matches = PROTECTED_MARKS.flatMap((mark) => matchMark(mark, words, text));

  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const key = `${m.markId}:${m.ambiguous}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const data = { markId: m.markId, owner: m.owner, found: m.found, kind: m.kind };
    const what = m.kind === 'slogan' ? `slogan "${m.found}"` : `"${m.found}"`;
    if (m.ambiguous) {
      issues.push(
        issue('AMBIGUOUS_MARK', 'WARNING', `${what} is an everyday word but also a trademark of ${m.owner}; a person should check the context.`, data),
      );
    } else if (opts.licenceReference) {
      issues.push(
        issue('LICENSED_MARK', 'WARNING', `${what} is a trademark of ${m.owner}; licence ${opts.licenceReference} must be verified before printing.`, {
          ...data,
          licenceReference: opts.licenceReference,
        }),
      );
    } else {
      issues.push(
        issue('PROTECTED_MARK', 'CRITICAL', `${what} matches a protected trademark of ${m.owner}; not OK to produce without authorisation.`, data),
      );
    }
  }
  return { matches, issues };
}

/** Flattened logo descriptions, for semantic matching against what the vision model sees. */
export function logoDescriptionCorpus(): { markId: string; owner: string; description: string }[] {
  return PROTECTED_MARKS.flatMap((m) => m.logoDescriptions.map((description) => ({ markId: m.id, owner: m.owner, description })));
}
