import { describe, expect, it } from 'vitest';
import { buildTimeline, type DelegationNode, describeResult } from '../src/lib/timeline';
import type { TraceEvent } from '../src/types';

let seq = 0;
const ev = (type: string, agent: string, data: Record<string, unknown> = {}): TraceEvent => ({ seq: ++seq, t: seq * 100, type, agent, data });

describe('buildTimeline', () => {
  it('nests tool calls and MCP calls under the delegation that made them', () => {
    const nodes = buildTimeline([
      ev('run.started', 'orchestrator'),
      ev('delegation.started', 'orchestrator', { to: 'preflight-agent', attempt: 1, task: 'Check print readiness.' }),
      ev('tool.called', 'preflight-agent', { tool: 'read_image_metadata' }),
      ev('mcp.call', 'preflight-agent', { server: 'mcp-artwork', tool: 'read_media_file', ok: true, durationMs: 12 }),
      ev('tool.result', 'preflight-agent', { tool: 'read_image_metadata', durationMs: 40, result: { widthPx: 1075, heightPx: 720, dpi: 300, colorSpace: 'cmyk', physicalSizeMm: { widthMm: 91, heightMm: 61 } } }),
      ev('tool.called', 'preflight-agent', { tool: 'check_bleed' }),
      ev('tool.result', 'preflight-agent', { tool: 'check_bleed', durationMs: 2, issues: [{ code: 'BLEED_MISSING', severity: 'CRITICAL' }], result: {} }),
      ev('delegation.completed', 'orchestrator', { to: 'preflight-agent', success: true, summary: 'Bleed is missing.' }),
      ev('guardrail.blocked', 'ip-agent', { attempted: 'save_report' }),
      ev('verdict', 'orchestrator', { verdict: 'REJECT', proposedVerdict: 'REJECT', agreesWithPolicy: true }),
    ]);
    const d = nodes[0] as DelegationNode;
    expect(d).toMatchObject({ kind: 'delegation', agent: 'preflight-agent', status: 'done', summary: 'Bleed is missing.' });
    expect(d.tools.map((t) => [t.tool, t.status])).toEqual([
      ['read_image_metadata', 'ok'],
      ['check_bleed', 'ok'],
    ]);
    expect(d.tools[0]!.mcp).toEqual([{ server: 'mcp-artwork', tool: 'read_media_file', ok: true, durationMs: 12 }]);
    expect(d.tools[0]!.detail).toBe('1075×720 px · 300 DPI · CMYK · 91×61 mm');
    expect(d.tools[1]!.issues).toEqual([{ code: 'BLEED_MISSING', severity: 'CRITICAL' }]);
    expect(nodes[1]).toMatchObject({ kind: 'note', tone: 'danger' });
    expect(nodes[2]).toMatchObject({ kind: 'verdict', verdict: 'REJECT', agrees: true });
  });

  it('shows a running tool while its result is still pending (live view)', () => {
    const nodes = buildTimeline([ev('delegation.started', 'orchestrator', { to: 'ip-agent' }), ev('tool.called', 'ip-agent', { tool: 'inspect_artwork_image' })]);
    expect((nodes[0] as DelegationNode).tools[0]!.status).toBe('running');
    expect((nodes[0] as DelegationNode).status).toBe('running');
  });
});

describe('describeResult', () => {
  it('summarises what the vision tool read', () => {
    expect(describeResult('inspect_artwork_image', { texts: ['NIKE Air', '50% off'], logos: [] })).toBe('“NIKE Air / 50% off”');
    expect(describeResult('validate_barcode', { barcode: '5012345678901', valid: false, expectedCheckDigit: 0 })).toBe('5012345678901: check digit should be 0');
  });
});

describe('buildTimeline with parallel tools', () => {
  it('attributes the shared artwork read to the first tool that started', () => {
    const nodes = buildTimeline([
      ev('delegation.started', 'orchestrator', { to: 'preflight-agent' }),
      ev('tool.called', 'preflight-agent', { tool: 'read_image_metadata' }),
      ev('tool.called', 'preflight-agent', { tool: 'check_bleed' }),
      ev('mcp.call', 'preflight-agent', { server: 'mcp-artwork', tool: 'read_media_file', ok: true, durationMs: 9 }),
    ]);
    const tools = (nodes[0] as DelegationNode).tools;
    expect(tools[0]!.mcp).toHaveLength(1);
    expect(tools[1]!.mcp).toHaveLength(0);
  });
});
