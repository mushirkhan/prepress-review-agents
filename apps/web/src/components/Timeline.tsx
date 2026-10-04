import { AGENT_LABEL, buildTimeline, type ToolNode } from '../lib/timeline';
import type { TraceEvent } from '../types';

const secs = (ms?: number) => (ms === undefined ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const at = (t: number) => `+${(t / 1000).toFixed(1)}s`;

function Tool({ node }: { node: ToolNode }) {
  return (
    <li className={`tool tool-${node.status}`}>
      <div className="tool-line">
        <span className="tool-icon" aria-hidden>
          {node.status === 'running' ? '◌' : node.status === 'ok' ? '✓' : '✕'}
        </span>
        <code className="tool-name">{node.tool}</code>
        {node.issues.map((i) => (
          <span key={i.code} className={`chip sev-${i.severity}`}>
            {i.code}
          </span>
        ))}
        <span className="tool-time">{secs(node.durationMs)}</span>
      </div>
      {node.detail ? <div className="tool-detail">{node.detail}</div> : null}
      {node.mcp.map((m, i) => (
        <div key={i} className={`mcp ${m.ok ? '' : 'mcp-failed'}`}>
          ↳ MCP <code>{m.server}</code> · <code>{m.tool}</code> {m.ok ? 'ok' : `failed: ${m.error}`} · {secs(m.durationMs)}
        </div>
      ))}
    </li>
  );
}

/** The live agent timeline: delegations, tool calls, MCP calls, guardrails, verdict. */
export function Timeline({ events, live }: { events: TraceEvent[]; live: boolean }) {
  const nodes = buildTimeline(events);
  if (!nodes.length) return <p className="muted">{live ? 'Waiting for the orchestrator…' : 'No activity recorded.'}</p>;
  return (
    <ol className="timeline">
      {nodes.map((n) => {
        if (n.kind === 'delegation') {
          return (
            <li key={n.key} className={`delegation agent-${n.agent} delegation-${n.status}`}>
              <div className="delegation-head">
                <span className="agent-dot" aria-hidden />
                <strong>{AGENT_LABEL[n.agent] ?? n.agent}</strong>
                <span className="muted">
                  {n.status === 'running' ? 'working…' : n.status === 'failed' ? 'could not finish' : 'done'}
                  {n.attempt > 1 ? ` · attempt ${n.attempt}` : ''}
                </span>
                <span className="tool-time">{at(n.t)}</span>
              </div>
              {n.task ? <div className="delegation-task">Orchestrator: “{n.task}”</div> : null}
              {n.tools.length ? (
                <ul className="tools">
                  {n.tools.map((t) => (
                    <Tool key={t.key} node={t} />
                  ))}
                </ul>
              ) : null}
              {n.summary ? <div className="delegation-summary">{n.summary}</div> : null}
            </li>
          );
        }
        if (n.kind === 'tool') {
          return (
            <li key={n.key} className="delegation agent-runtime">
              <ul className="tools">
                <Tool node={n} />
              </ul>
            </li>
          );
        }
        if (n.kind === 'note') {
          return (
            <li key={n.key} className={`note note-${n.tone}`}>
              {n.tone === 'danger' ? '⛔ ' : '✋ '}
              {n.text}
              <span className="tool-time">{at(n.t)}</span>
            </li>
          );
        }
        return (
          <li key={n.key} className={`note verdict-line verdict-${n.verdict}`}>
            <strong>Verdict policy: {n.verdict.replace(/_/g, ' ')}</strong>
            {n.proposed ? (
              <span className="muted">
                {' '}
                · orchestrator proposed {n.proposed.replace(/_/g, ' ')} {n.agrees ? '(agrees)' : '(overruled)'}
              </span>
            ) : null}
            <span className="tool-time">{at(n.t)}</span>
          </li>
        );
      })}
    </ol>
  );
}
