/**
 * Every step of a review is recorded as an event: delegations, tool calls,
 * tool results, guardrail decisions and the verdict. The trace powers the
 * live timeline in the web app, the stored audit log and the evaluation,
 * which scores runs from their traces.
 */
export type TraceEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.retried'
  | 'delegation.started'
  | 'delegation.rejected'
  | 'delegation.completed'
  | 'tool.called'
  | 'tool.result'
  | 'tool.error'
  | 'mcp.call'
  | 'guardrail.blocked'
  | 'agent.step'
  | 'verdict';

export interface TraceEvent {
  seq: number;
  /** Milliseconds since the run started. */
  t: number;
  type: TraceEventType;
  agent: string;
  data: Record<string, unknown>;
}

type Listener = (event: TraceEvent) => void;

export class TraceRecorder {
  readonly events: TraceEvent[] = [];
  private readonly started = Date.now();
  private readonly listeners = new Set<Listener>();

  record(type: TraceEventType, agent: string, data: Record<string, unknown> = {}): TraceEvent {
    const event: TraceEvent = { seq: this.events.length + 1, t: Date.now() - this.started, type, agent, data };
    this.events.push(event);
    for (const listen of this.listeners) {
      try {
        listen(event);
      } catch {
        // A failing subscriber (e.g. a closed live stream) must never break a review.
      }
    }
    return event;
  }

  /** Subscribe to new events; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ofType(type: TraceEventType): TraceEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}
