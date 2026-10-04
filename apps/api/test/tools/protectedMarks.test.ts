import { describe, expect, it } from 'vitest';
import { logoDescriptionCorpus, matchProtectedMarks } from '../../src/tools/ip/protectedMarks.js';
import { editDistance, normalize } from '../../src/tools/ip/text.js';

const codes = (texts: string[], licenceReference?: string) =>
  matchProtectedMarks(texts, { licenceReference }).issues.map((i) => `${i.code}:${i.data?.markId}`);

describe('normalize', () => {
  it('lower-cases, strips accents, punctuation and look-alike characters', () => {
    expect(normalize('N1KE Air — 50% OFF!')).toBe('nike air 50 off');
    expect(normalize("McDonald's")).toBe('mcdonalds');
    expect(normalize('Adídas')).toBe('adidas');
    expect(normalize('AD!DAS')).toBe('adidas');
    expect(normalize('Since 2026')).toBe('since 2026'); // digits-only words untouched
  });
});

describe('editDistance', () => {
  it('counts single edits', () => {
    expect(editDistance('adidaz', 'adidas')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});

describe('matchProtectedMarks', () => {
  it('flags a brand name as PROTECTED_MARK', () => {
    expect(codes(['NIKE Air', '50% off'])).toEqual(['PROTECTED_MARK:nike']);
  });

  it('flags disguised and misspelled names', () => {
    expect(codes(['N1KE running'])).toEqual(['PROTECTED_MARK:nike']);
    expect(codes(['ADIDAZ Originals'])).toEqual(['PROTECTED_MARK:adidas']);
    const [m] = matchProtectedMarks(['ADIDAZ Originals']).matches;
    expect(m?.kind).toBe('variant');
  });

  it('flags protected slogans even without the brand name', () => {
    expect(codes(['Just do it.'])).toEqual(['PROTECTED_MARK:nike']);
    expect(codes(['Impossible is nothing'])).toEqual(['PROTECTED_MARK:adidas']);
  });

  it('matches multi-word and punctuated names', () => {
    expect(codes(['Ice-cold COCA-COLA'])).toEqual(['PROTECTED_MARK:coca-cola']);
    expect(codes(["Breakfast at McDonald's"])).toEqual(['PROTECTED_MARK:mcdonalds']);
  });

  it('marks everyday words that are also brands as AMBIGUOUS_MARK', () => {
    expect(codes(['Fresh apple juice'])).toEqual(['AMBIGUOUS_MARK:apple']);
    expect(codes(['Sea shell collection'])).toEqual(['AMBIGUOUS_MARK:shell']);
  });

  it('downgrades to LICENSED_MARK when the ticket carries a licence reference', () => {
    const [i] = matchProtectedMarks(['NIKE Air'], { licenceReference: 'LIC-2026-0042' }).issues;
    expect(i).toMatchObject({ code: 'LICENSED_MARK', severity: 'WARNING', data: { licenceReference: 'LIC-2026-0042' } });
  });

  it.each([
    ['ordinary copy', 'Kettle & Leaf Tea Co. Since 2026'],
    ['short look-alike words are not fuzzy-matched', 'Bike shop: like new, ask Mike'],
    ['brand text split across unrelated words', 'Just in: do it yourself kits'],
  ])('does not flag %s', (_label, text) => {
    expect(codes([text])).toEqual([]);
  });

  it('reports one issue per mark even when it appears many times', () => {
    expect(codes(['NIKE', 'nike', 'Just do it'])).toEqual(['PROTECTED_MARK:nike']);
  });

  it('exposes logo descriptions for semantic matching', () => {
    expect(logoDescriptionCorpus()).toContainEqual({ markId: 'nike', owner: 'Nike, Inc.', description: 'swoosh' });
  });
});
