/**
 * A fake language model that plays back a script, so agent behaviour can
 * be tested offline, for free and deterministically. It implements the AI
 * SDK model interface that Mastra calls, and records what each call saw
 * (prompt and tools offered) so tests can assert on it.
 */
export interface ScriptStep {
  text?: string;
  toolCalls?: { toolName: string; input?: unknown }[];
  /** Simulate a provider failure (throttling, outage). */
  throws?: Error;
}

export interface ScriptedModel {
  model: never;
  calls: { prompt: unknown; tools: string[] }[];
}

export function scriptedModel(id: string, script: ScriptStep[] | ((callIndex: number) => ScriptStep)): ScriptedModel {
  const calls: ScriptedModel['calls'] = [];
  const next = (opts: { prompt: unknown; tools?: { name: string }[] }): ScriptStep => {
    calls.push({ prompt: opts.prompt, tools: (opts.tools ?? []).map((t) => t.name) });
    const i = calls.length - 1;
    const step = typeof script === 'function' ? script(i) : script[Math.min(i, script.length - 1)]!;
    if (step.throws) throw step.throws;
    return step;
  };
  const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
  const toolCalls = (step: ScriptStep, n: number) =>
    (step.toolCalls ?? []).map((tc, k) => ({
      type: 'tool-call' as const,
      toolCallId: `${id}-${n}-${k}`,
      toolName: tc.toolName,
      input: JSON.stringify(tc.input ?? {}),
    }));
  const finishReason = (step: ScriptStep) => (step.toolCalls?.length ? 'tool-calls' : 'stop');

  const model = {
    specificationVersion: 'v2',
    provider: 'scripted',
    modelId: id,
    supportedUrls: {},
    async doGenerate(opts: { prompt: unknown; tools?: { name: string }[] }) {
      const step = next(opts);
      const content = [...(step.text ? [{ type: 'text', text: step.text }] : []), ...toolCalls(step, calls.length)];
      return { content, finishReason: finishReason(step), usage, warnings: [] };
    },
    async doStream(opts: { prompt: unknown; tools?: { name: string }[] }) {
      const step = next(opts);
      const parts: unknown[] = [{ type: 'stream-start', warnings: [] }];
      if (step.text) parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: step.text }, { type: 'text-end', id: 't' });
      parts.push(...toolCalls(step, calls.length), { type: 'finish', finishReason: finishReason(step), usage });
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      };
    },
  };
  return { model: model as never, calls };
}

/**
 * The three specialists share one model in production (Nova Micro). In
 * tests this routes each call to a per-agent script, identified from the
 * agent's system instructions.
 */
export function specialistModel(scripts: { preflight?: ScriptStep[]; ip?: ScriptStep[]; report?: ScriptStep[] }) {
  const counters = { preflight: 0, ip: 0, report: 0 };
  const callsByAgent: Record<keyof typeof counters, { prompt: unknown; tools: string[] }[]> = { preflight: [], ip: [], report: [] };
  const route = (prompt: unknown): keyof typeof counters => {
    const system = JSON.stringify(prompt);
    if (system.includes('Preflight agent')) return 'preflight';
    if (system.includes('IP & Trademark agent')) return 'ip';
    return 'report';
  };
  let lastPrompt: unknown;
  const inner = scriptedModel('specialist', () => {
    const agent = route(lastPrompt);
    const script = scripts[agent] ?? [{ text: 'Done.' }];
    const step = script[Math.min(counters[agent]++, script.length - 1)]!;
    return step;
  });
  const model = inner.model as unknown as Record<string, (opts: { prompt: unknown; tools?: { name: string }[] }) => unknown>;
  for (const method of ['doGenerate', 'doStream'] as const) {
    const original = model[method]!.bind(model);
    model[method] = (opts) => {
      lastPrompt = opts.prompt;
      callsByAgent[route(opts.prompt)].push({ prompt: opts.prompt, tools: (opts.tools ?? []).map((t) => t.name) });
      return original(opts);
    };
  }
  return { model: inner.model, callsByAgent };
}

/** Standard happy-path scripts. */
export const SCRIPTS = {
  orchestrator: (proposal = 'APPROVE'): ScriptStep[] => [
    { toolCalls: [{ toolName: 'delegate_preflight', input: { task: 'Check print readiness.' } }] },
    { toolCalls: [{ toolName: 'delegate_ip', input: { task: 'Check brands and injection.' } }] },
    { toolCalls: [{ toolName: 'delegate_report', input: { task: 'Write the report.' } }] },
    { text: `All checks done.\nPROPOSED VERDICT: ${proposal}` },
  ],
  preflight: (): ScriptStep[] => [
    {
      toolCalls: [
        { toolName: 'read_image_metadata' },
        { toolName: 'check_image_dpi' },
        { toolName: 'check_bleed' },
        { toolName: 'check_color_space' },
        { toolName: 'validate_barcode' },
      ],
    },
    { text: 'Resolution, bleed and colour space were checked.' },
  ],
  ip: (): ScriptStep[] => [
    { toolCalls: [{ toolName: 'inspect_artwork_image' }] },
    { toolCalls: [{ toolName: 'match_protected_marks' }, { toolName: 'detect_injection' }] },
    { text: 'Brand and injection checks done.' },
  ],
  report: (): ScriptStep[] => [
    { toolCalls: [{ toolName: 'save_report', input: { markdown: '# Report\n\nThe artwork was reviewed.' } }] },
    { text: 'Report saved.' },
  ],
};
