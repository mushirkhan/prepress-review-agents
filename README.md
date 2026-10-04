# Prepress Review Agents

A multi-agent system that reviews print artwork before it goes to press. A reviewer uploads an image (200 KB or less) with a short job ticket, and the system returns **APPROVE**, **REJECT** or **NEEDS_HUMAN_REVIEW** with a written report.

- An **orchestrator agent** plans the review and delegates to specialist sub-agents.
- A **Preflight agent** checks print-readiness: resolution, bleed, colour space and barcode check digit.
- An **IP & Trademark agent** flags protected brand names, slogans and logos (for example Nike or Adidas) as not OK to produce.
- A **Report agent** writes the result to disk through an external MCP server.

> Status: work in progress. This README grows with each commit; sections marked _TODO_ are filled in as the matching code lands.

## Repositories

This project is developed in one local repository and pushed to two remotes with identical history:

| Remote | Visibility | Purpose |
|---|---|---|
| [GitHub: mushirkhan/prepress-review-agents](https://github.com/mushirkhan/prepress-review-agents) | Public | **For the examiner.** Review the code and the commit history, which shows how the system was built step by step. |
| GitLab: genai-rag/prepress-review-agents | Private | CI/CD only. The pipeline runs on a self-hosted GitLab group runner on the author's Proxmox server, builds the Docker images and deploys them to a dedicated VM published at `prepress.gemsofy.com` through Cloudflare Tunnel. |

`.gitlab-ci.yml` is included so the pipeline can be reviewed, but it only runs on GitLab. GitHub Actions runs lint, tests and a secret scan on every push.

## Contributing safely

The GitHub repository is public, so a gitleaks pre-commit hook blocks commits that contain anything that looks like a key or token. Enable it once per clone:

```bash
brew install gitleaks              # macOS; see gitleaks docs for other platforms
git config core.hooksPath .githooks
```

GitHub Actions repeats the scan on every push as a backstop.

## Architecture

_TODO_

## How responsibilities are divided between agents

| Agent | Model | Responsibility | Tools | Cannot |
|---|---|---|---|---|
| **Orchestrator** | Nova Lite | Plans the review and delegates; proposes a verdict | `delegate_preflight`, `delegate_ip`, `delegate_report` (delegation only) | See the artwork, run checks, write files |
| **Preflight** | Nova Micro | Print-readiness: resolution, bleed, colour space, barcode | `read_image_metadata`, `check_image_dpi`, `check_bleed`, `check_color_space`, `validate_barcode` | Judge brands, decide the verdict, write |
| **IP & Trademark** | Nova Micro (+ Nova Lite vision inside one tool) | Protected brands, slogans, logos; manipulation attempts | `inspect_artwork_image`, `match_protected_marks`, `search_mark_descriptions`, `detect_injection` | Check print quality, decide the verdict, write |
| **Report** | Nova Micro | Writes the report for the customer | `save_report` (the only write in the system) | Change the verdict or findings |

The agents are built with [Mastra](https://mastra.ai) (agents, tools and the tool-calling loop). Delegation uses three explicit tools with a one-field input (`{ task }`) rather than Mastra's built-in sub-agent tools: their input schema has many optional and multi-type fields, and Nova Lite produced malformed tool calls with it in live testing.

**How work is delegated.** The orchestrator delegates to Preflight and IP & Trademark, then to Report. Every delegation tool applies the same guardrails before running the specialist:

- rebuilds the specialist's brief from the job ticket, so the orchestrator's wording cannot change what is checked;
- blocks the Report agent until both checks have finished;
- stops repeat delegations to an agent that already finished, and caps attempts and steps per agent.

**How information flows.** Tools read the job's file from the run's context, never from a path chosen by a model. Each tool returns a small result for the model to reason about and records structured `Issue`s for the system. The verdict is computed by code from those issues (`decideVerdict`): any `CRITICAL` → **REJECT**, any `WARNING` → **NEEDS_HUMAN_REVIEW**, otherwise **APPROVE**. A required check that did not run becomes `CHECK_INCOMPLETE` (a warning), so a model cannot produce a pass by skipping work. The Report agent receives the policy's verdict and the findings, and the system writes the verdict line into the saved report itself.

**Why models at all?** Models decide which checks to run, read the text on the image, judge context ("apple" in "apple juice") and explain results in plain language. Measurements and the final decision are deterministic code, so they are testable, repeatable and cannot be talked out of a finding.

**Failure handling.** Tool errors come back to the agent as values; tools time out; vision output is schema-checked and retried once; Bedrock throttling is retried with backoff. If anything still fails, the review fails closed (never APPROVE) and a report is always written, from a template if the Report agent did not save one. Every step is recorded in a trace (delegations, tool calls, results, blocked calls, verdict) that drives the live timeline and the evaluation.

## Tools and the external MCP server

Agents act only through tools. The domain tools are plain, deterministic TypeScript functions: the model decides **when** to call them and explains the results, but never measures pixels or matches trademarks itself. That keeps the checks testable and repeatable.

| Tool | Used by | What it does |
|---|---|---|
| `readImageMetadata` | Preflight | Pixel size, declared DPI and colour space via `sharp`. Fully decodes the file, so empty, non-image and truncated files fail with a clear reason |
| `checkImageDpi` | Preflight | `LOW_RESOLUTION` below the ticket's minimum DPI |
| `checkBleed` | Preflight | File must measure trim + bleed (either orientation, 0.5 mm tolerance); exactly trim size is `BLEED_MISSING` |
| `checkColorSpace` | Preflight | RGB artwork on a CMYK job is `WRONG_COLOR_SPACE` |
| `validateEan13` | Preflight | Recomputes the barcode check digit |
| `matchProtectedMarks` | IP & Trademark | Brand names and slogans from a fixed registry; catches look-alikes (`N1KE`) and misspellings (`ADIDAZ`); everyday words such as "apple" are flagged as ambiguous, not rejected |
| `detectInjection` | IP & Trademark | Flags text on the artwork that tries to instruct the review system |

Every tool returns structured `Issue`s with a fixed code and a severity (`CRITICAL`, `WARNING`, `INFO`), so the verdict policy and the evaluation work on codes rather than free text.

### The external MCP server

Agents never touch the filesystem directly. They reach files only through **[`@modelcontextprotocol/server-filesystem`](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)**, an MCP server maintained by the MCP project, using the official MCP TypeScript SDK client.

| Connection | Server sees | Mounted | Tools the server offers | Tools this client may call | Used by |
|---|---|---|---|---|---|
| `mcp-artwork` | artwork folder only | read-only | 14 (`read_media_file`, `write_file`, `move_file`, …) | `read_media_file` | Preflight and IP & Trademark tools |
| `mcp-reports` | reports folder only | read-write | 14 | `write_file` | Report agent's `save_report` |

Three independent layers keep the agents inside their scope:

1. **Client allowlist.** Each connection refuses any MCP tool outside its list before a request leaves the API.
2. **Server boundary.** Each server instance is started with one folder; anything outside it is refused by the server (`Access denied - path outside allowed directories`).
3. **Operating system.** The artwork folder is mounted read-only into its MCP container, so artwork cannot be modified even if both layers above failed.

File paths are built from a validated job id by the store, never by a model. Every MCP call appears in the trace under the agent whose tool made it. In production each server runs in its own container behind a small stdio-to-HTTP bridge on an internal network with no internet access; in local development and tests it is started over stdio.


## Sample artwork

[`samples/`](samples/README.md) holds 13 generated artwork files and 4 invalid uploads, each with a job ticket and an expected result in `samples/manifest.json`. They are generated from known inputs, so the expected results are ground truth by construction. Use them to try the app, and they double as the evaluation's golden set.

## Running the application

### Locally

```bash
npm ci
AUTH_MODE=dev npm run dev -w @prepress/api     # API on http://localhost:3000, no sign-in (refused in production)
```

Put the `prepress-app` IAM user's keys in a `.env` file at the repository root (see `.env.example`; it is git-ignored). Without AWS credentials the API still runs, and every review fails closed as `NEEDS_HUMAN_REVIEW`. Locally, the external MCP filesystem server is started over stdio automatically.

### API

All endpoints except `/healthz` need a Cognito access token issued to the `prepress-web` client for a user in the `prepress-reviewers` group.

| Method and path | What it does |
|---|---|
| `POST /jobs` | Upload artwork (`file`, 200 KB or less) and a JSON job ticket (`ticket`). Returns `202` with the job id; the review runs in the background. Invalid uploads are refused before any model runs: `400` empty, `413` too large, `415` not a JPEG/PNG/TIFF by content, `422` undecodable. |
| `GET /jobs` | Your jobs, newest first |
| `GET /jobs/:id` | Status, verdict, issues per agent, agent summaries, boundary violations, token usage |
| `GET /jobs/:id/events` | **Live trace** (Server-Sent Events): every delegation, tool call, MCP call and guardrail decision as it happens; replays finished runs; resumes with `Last-Event-ID` |
| `GET /jobs/:id/report` | The Markdown report |
| `GET /jobs/:id/artwork` | A browser-friendly preview of the upload |
| `GET /samples`, `GET /samples/:id/file` | The sample set, for trying the app |

Each user can start 10 reviews per 10 minutes, and at most 2 reviews run at once. Another user's job always returns `404`.

## Running the tests and evaluations

```bash
npm ci
npm run check                                  # lint, typecheck and all tests (offline, no AWS)
npm run review -w @prepress/api -- flyer-nike  # one live review against Bedrock (needs AWS credentials in .env)
```

The agent tests use a scripted model that plays back each agent's steps, so delegation, tool use, guardrails and failure handling are tested offline, for free and deterministically.

The live evaluation is described under [Evaluation approach](#evaluation-approach).

## Evaluation approach

The evaluation asks **"does the system behave correctly?"**, not "is the model clever?". It runs every sample through the whole system against real Bedrock and scores each run with plain code, from the result and the trace. The full reasoning is in [`apps/api/evals/README.md`](apps/api/evals/README.md); in short:

- **Ground truth by construction.** The samples are generated from known inputs, so the expected verdicts and issue codes are facts.
- **Outcome and behaviour.** Besides the verdict and issue codes (precision and recall), each run is checked for *how* it got there: every required check ran, no out-of-scope tool calls, correct delegation order, the Report agent wrote a report that covers the findings, one artwork read through MCP, and whether the orchestrator's own proposal matched the policy.
- **No LLM judge.** Every question here has an exact answer, so deterministic checks are cheaper, repeatable and cannot be talked round.
- **Asymmetric gates.** Approving infringing or unprintable artwork is the costly mistake, so **unsafe approvals must be zero**; boundary violations must be zero; verdict accuracy and check completion must be at least 90%.
- **Stability.** `--repeat N` reruns each sample and lists any whose verdict changed.
- **The evaluation is tested too.** Offline tests show it passes a correct system and fails a broken one (a blind vision model, an agent that skips its checks).

```bash
npm run eval -w @prepress/api -- --repeat 3 --publish   # writes apps/api/evals/RESULTS.md
```

`--publish` writes the summary to `apps/api/evals/RESULTS.md`, which is committed with each published run.

## Deployment (CI/CD)

```
push to main ──► GitLab: check ──► build_api ──► deploy ──► app VM (deploy.sh)
                 lint, typecheck,   image tagged   SSH with a      pull, start,
                 offline tests      with git SHA   restricted key  health check,
                                                                   roll back on failure
```

- The pipeline runs on a self-hosted GitLab group runner (Docker executor) on the author's Proxmox server.
- `build_api` pushes `registry.gitlab.com/genai-rag/prepress-review-agents/api:<short-sha>`.
- `deploy` connects with an SSH key that the VM restricts to running `/opt/prepress/deploy.sh`, so the key cannot open a shell. The compose file is sent on stdin and the image tag must be a git SHA.
- `deploy.sh` keeps the previous release and rolls back automatically if `/healthz` does not respond within 60 seconds.
- No ports are published on the VM. Public traffic reaches it only through Cloudflare Tunnel.

One-time VM setup (already done for the live environment): copy `infra/deploy.sh` to `/opt/prepress/deploy.sh` and create `/opt/prepress/.env` from `.env.example`.

## Assumptions and limitations

- Artwork input is a single JPEG, PNG or TIFF of 200 KB or less. At 300 DPI this covers small formats such as business cards, A6 flyers and labels.
- SSH to the app VM uses password login and is reachable from the home LAN only.

## Taking this to production

_TODO_
