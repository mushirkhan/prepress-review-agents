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

## Assumptions and limitations

- Artwork input is a single JPEG, PNG or TIFF of 200 KB or less. At 300 DPI this covers small formats such as business cards, A6 flyers and labels.
- SSH to the app VM uses password login and is reachable from the home LAN only.

## Taking this to production

_TODO_
