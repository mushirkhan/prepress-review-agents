import type { TraceEvent } from '../types';

export const AGENT_LABEL: Record<string, string> = {
  orchestrator: 'Orchestrator',
  'preflight-agent': 'Preflight',
  'ip-agent': 'IP & Trademark',
  'report-agent': 'Report',
  runtime: 'System',
};

export interface McpCall {
  server: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface ToolNode {
  kind: 'tool';
  key: string;
  agent: string;
  tool: string;
  status: 'running' | 'ok' | 'error';
  t: number;
  durationMs?: number;
  detail?: string;
  issues: { code: string; severity: string }[];
  mcp: McpCall[];
}

export interface DelegationNode {
  kind: 'delegation';
  key: string;
  agent: string;
  status: 'running' | 'done' | 'failed';
  t: number;
  task?: string;
  summary?: string;
  attempt: number;
  tools: ToolNode[];
}

export interface NoteNode {
  kind: 'note';
  key: string;
  tone: 'info' | 'warn' | 'danger';
  agent: string;
  t: number;
  text: string;
}

export interface VerdictNode {
  kind: 'verdict';
  key: string;
  t: number;
  verdict: string;
  proposed?: string;
  agrees?: boolean;
}

export type TimelineNode = DelegationNode | ToolNode | NoteNode | VerdictNode;

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** One readable line for a tool's result, from the facts it returned. */
export function describeResult(tool: string, r: Record<string, unknown> | undefined): string | undefined {
  if (!r) return undefined;
  if (r.skipped) return `skipped: ${str(r.reason)}`;
  switch (tool) {
    case 'read_image_metadata': {
      const size = r.physicalSizeMm as { widthMm?: number; heightMm?: number } | undefined;
      return `${r.widthPx}×${r.heightPx} px · ${r.dpi ?? '?'} DPI · ${String(r.colorSpace).toUpperCase()} · ${size?.widthMm}×${size?.heightMm} mm`;
    }
    case 'check_image_dpi':
      return `${r.dpi} DPI (minimum ${r.minDpi})`;
    case 'check_bleed': {
      const a = r.actualMm as { widthMm?: number; heightMm?: number } | undefined;
      return `${a?.widthMm}×${a?.heightMm} mm, needs trim + ${r.bleedMm} mm bleed`;
    }
    case 'check_color_space':
      return `${String(r.colorSpace).toUpperCase()} (job expects ${r.expected})`;
    case 'validate_barcode':
      return `${r.barcode}: check digit ${r.valid ? 'valid' : `should be ${r.expectedCheckDigit}`}`;
    case 'inspect_artwork_image': {
      const texts = (r.texts as string[] | undefined) ?? [];
      const logos = (r.logos as string[] | undefined) ?? [];
      return `${texts.length ? `“${texts.join(' / ')}”` : 'no text'}${logos.length ? ` · logos: ${logos.join(', ')}` : ''}`;
    }
    case 'match_protected_marks': {
      const m = (r.matches as { found: string; owner: string }[] | undefined) ?? [];
      return m.length ? m.map((x) => `“${x.found}” (${x.owner})`).join(', ') : 'no protected marks';
    }
    case 'detect_injection':
      return r.detected ? `instruction-like text found (${(r.patterns as string[]).join(', ')})` : 'no instructions in the text';
    case 'save_report':
    case 'fallback_report':
      return str(r.path);
    default:
      return undefined;
  }
}

/**
 * Folds the flat trace into a tree for display: each delegation holds the
 * tool calls its specialist made, each tool call holds its MCP calls.
 * Works incrementally on a growing event list (live view).
 */
export function buildTimeline(events: TraceEvent[]): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  const openDelegation = new Map<string, DelegationNode>();
  const openTools = new Map<string, ToolNode>(); // "agent:tool" -> running call

  const place = (agent: string, node: ToolNode) => {
    const d = openDelegation.get(agent);
    if (d) d.tools.push(node);
    else nodes.push(node);
  };

  for (const e of events) {
    const d = e.data;
    switch (e.type) {
      case 'delegation.started': {
        const node: DelegationNode = {
          kind: 'delegation',
          key: `d${e.seq}`,
          agent: str(d.to),
          status: 'running',
          t: e.t,
          task: str(d.task),
          attempt: Number(d.attempt ?? 1),
          tools: [],
        };
        openDelegation.set(node.agent, node);
        nodes.push(node);
        break;
      }
      case 'delegation.completed': {
        const node = openDelegation.get(str(d.to));
        if (node) {
          node.status = d.success ? 'done' : 'failed';
          node.summary = str(d.summary) || str(d.error) || undefined;
          openDelegation.delete(node.agent);
        }
        break;
      }
      case 'delegation.rejected':
        nodes.push({ kind: 'note', key: `n${e.seq}`, tone: 'warn', agent: 'orchestrator', t: e.t, text: `Delegation to ${AGENT_LABEL[str(d.to)] ?? str(d.to)} refused: ${str(d.reason)}` });
        break;
      case 'tool.called': {
        const node: ToolNode = { kind: 'tool', key: `t${e.seq}`, agent: e.agent, tool: str(d.tool), status: 'running', t: e.t, issues: [], mcp: [] };
        openTools.set(`${e.agent}:${node.tool}`, node);
        place(e.agent, node);
        break;
      }
      case 'tool.result':
      case 'tool.error': {
        const k = `${e.agent}:${str(d.tool)}`;
        let node = openTools.get(k);
        if (!node) {
          node = { kind: 'tool', key: `t${e.seq}`, agent: e.agent, tool: str(d.tool), status: 'running', t: e.t, issues: [], mcp: [] };
          place(e.agent, node);
        }
        node.status = e.type === 'tool.result' ? 'ok' : 'error';
        node.durationMs = d.durationMs as number | undefined;
        node.detail = e.type === 'tool.error' ? str(d.error) : describeResult(node.tool, d.result as Record<string, unknown>);
        node.issues = (d.issues as ToolNode['issues'] | undefined) ?? [];
        openTools.delete(k);
        break;
      }
      case 'mcp.call': {
        const call: McpCall = { server: str(d.server), tool: str(d.tool), ok: Boolean(d.ok), durationMs: Number(d.durationMs ?? 0), ...(d.error ? { error: str(d.error) } : {}) };
        // Parallel tools share one load, made by the first of them to start.
        const running = [...openTools.values()].find((n) => n.agent === e.agent);
        if (running) running.mcp.push(call);
        break;
      }
      case 'guardrail.blocked':
        nodes.push({ kind: 'note', key: `n${e.seq}`, tone: 'danger', agent: e.agent, t: e.t, text: `${AGENT_LABEL[e.agent] ?? e.agent} tried to call ${str(d.attempted)}: blocked (not in its allowlist)` });
        break;
      case 'run.retried':
        nodes.push({ kind: 'note', key: `n${e.seq}`, tone: 'warn', agent: 'orchestrator', t: e.t, text: `Model error, retrying the orchestrator: ${str(d.error)}` });
        break;
      case 'run.failed':
        nodes.push({ kind: 'note', key: `n${e.seq}`, tone: 'danger', agent: 'orchestrator', t: e.t, text: `Run failed: ${str(d.error)}. The review fails closed.` });
        break;
      case 'verdict':
        nodes.push({
          kind: 'verdict',
          key: `v${e.seq}`,
          t: e.t,
          verdict: str(d.verdict),
          ...(d.proposedVerdict ? { proposed: str(d.proposedVerdict) } : {}),
          ...(typeof d.agreesWithPolicy === 'boolean' ? { agrees: d.agreesWithPolicy } : {}),
        });
        break;
      default:
        break;
    }
  }
  return nodes;
}
