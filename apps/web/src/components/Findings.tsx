import { AGENT_LABEL } from '../lib/timeline';
import type { Issue } from '../types';

/** Issues grouped by the agent whose tools found them. */
export function Findings({ issues }: { issues: Issue[] }) {
  if (!issues.length) return <p className="muted">No issues found.</p>;
  const byAgent = new Map<string, Issue[]>();
  for (const i of issues) byAgent.set(i.agent, [...(byAgent.get(i.agent) ?? []), i]);
  return (
    <div className="findings">
      {[...byAgent].map(([agent, list]) => (
        <div key={agent} className={`finding-group agent-${agent}`}>
          <h4>
            <span className="agent-dot" aria-hidden />
            {agent === 'orchestrator' ? 'Coverage check' : AGENT_LABEL[agent] ?? agent}
          </h4>
          <ul>
            {list.map((i) => (
              <li key={`${i.code}-${i.message}`}>
                <span className={`chip sev-${i.severity}`}>{i.severity}</span> <code>{i.code}</code> {i.message}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
