# Evaluation

`npm run eval -w @prepress/api` runs every sample artwork through the whole system (orchestrator, specialist agents, tools, the external MCP server, the verdict policy and the report) against real Bedrock models, then scores each run. One run of all 13 samples takes a few minutes and costs a few cents.

```bash
npm run eval -w @prepress/api                          # every sample once
npm run eval -w @prepress/api -- --repeat 3            # three runs each, to measure stability
npm run eval -w @prepress/api -- --only flyer-nike     # one sample
npm run eval -w @prepress/api -- --publish             # also write evals/RESULTS.md
```

Results are saved to `evals/results/<timestamp>.{json,md}`, and the command exits non-zero if a gate fails. In GitLab it is the manual `eval` job.

## What it asks

The question is not "is the model clever?" but **"does the system behave correctly?"** Two halves:

**Outcome:** is the answer right?

- Verdict matches the expected verdict.
- Exactly the expected issue codes were found (precision and recall over all codes).

**Behaviour:** did it get there the right way?

| Check | Why it matters |
|---|---|
| Every required check ran | A right answer reached by skipping checks is luck, not correctness |
| No out-of-scope tool calls | Agents must stay inside their responsibilities |
| Preflight and IP delegated once each, both before the report | Delegation works as designed: no loops, no report before the facts |
| The Report agent saved the report itself | The fallback template exists for failures; needing it is a failure |
| The report mentions every finding | The customer must be able to act on it |
| Artwork read exactly once through MCP | Efficiency and the shared-load fix stay in place |
| The orchestrator's proposed verdict matches the policy | Measures whether the model understood its findings (informational: the policy decides) |

Plus cost and speed per review (tokens, seconds) and **stability**: with `--repeat`, any sample whose verdict changes between runs is listed.

## Why it is built this way

- **Ground truth by construction.** Each sample is generated from known inputs (`samples/manifest.json`), so "expected" is a fact, not someone's opinion of an image.
- **Deterministic scoring, no LLM judge.** Every check is code over the result and the trace. That makes it repeatable, free and impossible to talk round. An LLM judge would add cost and its own errors, for questions that have exact answers here.
- **Behaviour, not just answers.** The trace records every delegation, tool call and guardrail decision, so the evaluation can see *how* a verdict was reached. A system that gets the right verdict by skipping a check fails.
- **Mistakes do not cost the same.** Approving infringing or unprintable artwork is the expensive mistake; sending a good file to a person costs a few minutes. So **unsafe approvals must be zero** (a hard gate), while overall accuracy only has a threshold.
- **Small on purpose.** 13 cases cover every verdict, every issue code, a misspelling, an ambiguous word, a licence and an injection attempt: enough to catch regressions after a prompt, model or code change, and cheap enough to run on every release.

## Gates

| Gate | Threshold |
|---|---|
| Unsafe approvals | 0 |
| Boundary violations | 0 |
| Verdict accuracy | 90% or more |
| Runs with every check completed | 90% or more |

## How the evaluation is itself tested

`test/evals/harness.test.ts` runs the real harness offline with scripted models and the real MCP server, and shows it **passes a correct system and fails broken ones**: a blind vision model (three unsafe approvals: the NIKE flyer, the injection attempt and the "apple juice" label) and an agent that skips its checks (coverage gate fails).

## Limitations

- Synthetic artwork: clean fonts and flat colours. Real artwork (photos, small print, rotated text, real logos) is harder for the vision step.
- 13 cases cannot measure small differences in accuracy; they catch regressions.
- Brand detection uses a fixed registry of a few marks; there are no real logos in the set.
