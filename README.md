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

_TODO_

## Tools and the external MCP server

_TODO_

## Running the application

_TODO_

## Running the tests and evaluations

_TODO_

## Evaluation approach

_TODO_

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
