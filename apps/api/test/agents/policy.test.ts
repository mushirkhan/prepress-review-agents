import { describe, expect, it } from 'vitest';
import { createJobContext } from '../../src/agents/context.js';
import { coverageIssues, decideVerdict, parseProposedVerdict } from '../../src/agents/policy.js';
import { issue } from '../../src/domain/issues.js';
import { JobTicketSchema } from '../../src/domain/ticket.js';
import { FakeVision, MemoryStore } from '../helpers/fakes.js';

const critical = issue('PROTECTED_MARK', 'CRITICAL', 'NIKE');
const warning = issue('AMBIGUOUS_MARK', 'WARNING', 'apple');
const info = issue('WRONG_COLOR_SPACE', 'INFO', 'greyscale');

describe('decideVerdict', () => {
  it.each([
    ['no issues', [], 'APPROVE'],
    ['only INFO notes', [info], 'APPROVE'],
    ['a WARNING', [warning, info], 'NEEDS_HUMAN_REVIEW'],
    ['a CRITICAL issue', [critical], 'REJECT'],
    ['CRITICAL beats WARNING', [warning, critical], 'REJECT'],
  ] as const)('%s -> %s', (_label, issues, verdict) => {
    expect(decideVerdict([...issues]).verdict).toBe(verdict);
  });

  it('gives the messages of the deciding issues as reasons', () => {
    expect(decideVerdict([warning, critical]).reasons).toEqual(['NIKE']);
  });
});

describe('coverageIssues', () => {
  const job = (barcode?: string) =>
    createJobContext({
      jobId: 'j',
      ticket: JobTicketSchema.parse({ jobName: 'x', trimWidthMm: 85, trimHeightMm: 55, ...(barcode ? { barcode } : {}) }),
      deps: { store: new MemoryStore(new Map()), vision: new FakeVision({ texts: [], logos: [] }) },
    });

  it('reports every required check that did not run', () => {
    const codes = coverageIssues(job()).map((i) => i.data);
    expect(codes).toEqual([
      { agent: 'preflight-agent', missing: ['check_image_dpi', 'check_bleed', 'check_color_space'] },
      { agent: 'ip-agent', missing: ['match_protected_marks', 'detect_injection'] },
    ]);
  });

  it('requires the barcode check only when the ticket has a barcode', () => {
    const j = job('5012345678900');
    j.state.completedTools.set('preflight-agent', new Set(['check_image_dpi', 'check_bleed', 'check_color_space']));
    j.state.completedTools.set('ip-agent', new Set(['match_protected_marks', 'detect_injection']));
    expect(coverageIssues(j).map((i) => i.data)).toEqual([{ agent: 'preflight-agent', missing: ['validate_barcode'] }]);
  });
});

describe('parseProposedVerdict', () => {
  it.each([
    ['PROPOSED VERDICT: REJECT', 'REJECT'],
    ['Done.\nproposed verdict: **needs_human_review**', 'NEEDS_HUMAN_REVIEW'],
    ['I think it is fine', undefined],
  ])('%j -> %s', (text, verdict) => {
    expect(parseProposedVerdict(text)).toBe(verdict);
  });
});
