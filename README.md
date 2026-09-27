# flue-agent-org

150 autonomous agents — one per human role in the 20-function software org —
built on **Flue** (the agent harness framework) and deployed on
**Cloudflare's Agent Cloud** (Durable Objects, Workflows, Containers,
Workers AI, AI Gateway, native MCP). This is a generated project, not a
hand-authored one: `skills.sh` is the entrypoint, `roles.json` +
`area-config.json` are the source of truth, and `scripts/generate-agents.mjs`
does the actual writing.

## Layout

```
roles.json                 150 roles: {id, area, name, desc}
area-config.json           20 areas → {tier, sandbox, model, mcp[]}
skills.sh                  entrypoint: generate | clean | count
scripts/generate-agents.mjs   the generator
agents/<area>/<role>.ts    150 Flue agent definitions (generated)
skills/<role>/SKILL.md     150 skills the agents load (generated)
registry.ts                id → agent lookup table (generated)
wrangler.toml              Cloudflare bindings: DOs, Workflows, Containers (generated)
```

Regenerate everything after editing `roles.json` or `area-config.json`:

```bash
./skills.sh generate
```

## Why this shape

This mirrors the "AI digital twin" stack described in the source doc:
Kubernetes/Temporal are retired in favor of **Durable Objects + Workflows +
Containers** — purpose-built for long-running, stateful, serverless agents —
and **Flue** replaces raw LLM-API glue code with agent functions plus hooks
(`useModel` / `useSandbox` / `useSkill` / `useMcpConnection`) and Markdown
skills.

### The three execution tiers

Every generated agent is pinned to one tier in `area-config.json`, based on
what its function actually needs to do:

| Tier | Cloudflare primitive | Who's in it |
|---|---|---|
| **Tier 0 — Workspace** | Durable Object + SQLite/R2, no code execution | Product, BA, UX Research, Design, Docs, PM, Agile, Marketing, Sales, Support, Legal |
| **Tier 1 — Dynamic Worker** | V8 isolate, no network, fast cold start | Software Architecture (design docs, no execution needed yet) |
| **Container / Sandbox** | Full toolchain, escalates from Tier 1 on demand | Frontend/Backend/Full-Stack/Mobile Dev, DevOps, QA, Data Eng, Security |

QA/Security containers are **ephemeral** (fresh filesystem per run, per the
source doc's Phase 5 self-test loop); dev containers are pooled.

### Model assignment

Flue is model-agnostic, so `area-config.json` routes each area to whichever
model fits its cost/quality tradeoff, all through **AI Gateway** for
caching, fallback, and cost tracking:

- **Leadership/judgment-heavy roles** (Chief/VP/Director/Lead titles, plus
  Architecture and Legal) → `anthropic/claude-opus-4-6`, confidence floor
  raised to 0.80.
- **Core execution roles** (most dev, PM, sales) → `anthropic/claude-sonnet-4-6`.
- **High-volume, lower-stakes roles** (support tier-1, QA execution,
  marketing copy, docs) → a Workers AI open model
  (`@cf/meta/llama-3.3-70b-instruct`) — no external API cost.

Swap any of this by editing `area-config.json` and re-running `skills.sh`;
no agent file is hand-edited directly.

### MCP tools

Each area is wired to the MCP servers its function actually uses —
GitHub for dev/DevOps/architecture, Figma for design/UX, Jira/Slack for
PM/Agile/BA, Slack/Discord for support, Google Drive for legal/docs. Add a
tool to an area by editing its `mcp` array in `area-config.json`.

### Governance is a rule, not a role

Every generated `SKILL.md` and agent file bakes in the same escalation
contract used in the source doc's Governance tab: self-approve only above a
confidence floor (0.70, or 0.80 for leadership roles), and **always**
escalate regardless of confidence when a task trips a fixed trigger — legal,
budget > $10k, a live incident, customer-facing comms, or a major
architecture change. Nothing here decides those triggers at inference time;
they're read from `wrangler.toml`'s `[vars]` block so they're versioned and
auditable, not a judgment call baked into a prompt.

## Wiring agents into a Workflow

`registry.ts` exposes `getAgentByRoleId('7.2')` → the Backend Developer
agent, so a `Cloudflare Workflow` (e.g. the six-phase SDLC pipeline from the
source doc: intake → spec → parallel design/dev → self-test loop → policy
check → release) can look up whichever agent a phase needs by role id
instead of importing all 150 modules directly.

## Deploying

```bash
pnpm install          # @flue/runtime + @flue/cli
npx wrangler deploy
```

`wrangler.toml` declares one Durable Object class per functional area (20
classes), a shared `AgentSessionDO` for per-run state, a Workflow binding for
the SDLC pipeline, and a Container pool for Tier-1→Container escalation.

## Symphony integration

See `symphony-integration/` for a real, verified integration with
[openai/symphony](https://github.com/openai/symphony)'s Elixir reference
implementation: a forked `linear/agent_tool.ex` (compiles clean against the
actual upstream source), a `WORKFLOW.flue.md`, and `server/dispatch.mjs` +
`role-label-map.json` at the repo root as the routing bridge between
Symphony (Elixir) and this repo's Flue agents (TypeScript).
