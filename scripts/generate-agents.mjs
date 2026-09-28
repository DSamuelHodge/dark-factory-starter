#!/usr/bin/env node
// generate-agents.mjs
// Reads roles.json (150 human roles across 20 functional areas) and
// area-config.json (tier/sandbox/model/MCP mapping) and emits, per role:
//   agents/<area-slug>/<role-slug>.ts   — a Flue agent definition
//   skills/<role-slug>/SKILL.md         — the Markdown skill it loads
// plus registry.ts (id -> agent import map, for bundler/app use),
// registry.json (id -> agent file map, for plain-Node use by
// scripts/run-agent.mjs, which cannot import .ts), and wrangler.toml
// (Durable Object + Workflow bindings for the Cloudflare Agent Cloud layer).
//
// The emitted agent code targets the VERIFIED @flue/runtime 2.1.x API
// (each shape below was run end-to-end through `flue run --json`):
//   - plain agent function + 'use agent' directive (no createAgent wrapper)
//   - plain SKILL.md specifier import + useSkill() (no `with` attribute)
//   - useMcpConnection({ name, url }) inline (no defineMcpTools helper)
//   - sandboxed tiers use useSandbox(local()) from '@flue/runtime/node';
//     the deploy target re-maps these via the vite flue() plugin config
//   - durable identity pinned with the agentName static (rename-safe DB keys)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const pascal = (s) =>
  s
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");

const mcpUrlFor = (name) =>
  ({
    github: "https://mcp.github.com/mcp",
    figma: "https://mcp.figma.com/mcp",
    linear: "https://mcp.linear.app/mcp", // per Flue's own MCP guide example
    jira: "https://mcp.atlassian.com/jira/mcp",
    slack: "https://mcp.slack.com/mcp",
    discord: "https://mcp.discord.com/mcp",
    gdrive: "https://drivemcp.googleapis.com/mcp/v1",
    cloudflare: "https://bindings.mcp.cloudflare.com/mcp",
  }[name] || `https://mcp.example.com/${name}`);

// MCP servers whose auth comes from an env var (service-wide static token
// per Flue's MCP guide). The key itself lives in pass / wrangler secrets /
// .dev.vars — the generated code only names the variable, never a value.
// Servers without an entry bind tools optimistically (optional: true) and
// run without them when the route is unreachable.
const mcpAuthEnvFor = (name) =>
  ({
    linear: "LINEAR_API_KEY",
  }[name] || null);

// Model providers that need a code registration (custom setProvider call)
// instead of just a useModel() specifier. The module registers itself on
// import; generated agents import it only when their area routes there.
const providerImportFor = (model) =>
  model.startsWith("meta/") ? "../../providers/meta.ts" : null;

// Roles whose title signals "leadership tier" — escalate confidence
// threshold and give them the pricier model regardless of area default.
const LEADERSHIP_RE =
  /\b(Chief|VP|Head of|Director|Lead\/Principal|Lead$|Manager$)\b/;

function tierComment(tier) {
  switch (tier) {
    case "tier0":
      return "Tier 0 — Workspace (SQLite + R2, no code execution)";
    case "tier1":
      return "Tier 1 — Dynamic Worker (V8 isolate, no network, fast cold start)";
    case "container":
      return "Escalates Tier 1 → Cloudflare Container/Sandbox for full toolchain execution";
    default:
      return tier;
  }
}

function buildSkillMd(role, cfg) {
  // Frontmatter `name` must match the directory name and `description` is
  // required — both verified against @flue/runtime 2.1.x skill packaging.
  return `---
name: ${slugify(role.name)}
description: Autonomous counterpart to the human "${role.name}" role (${role.area}).
role_id: ${role.id}
area: ${role.area}
---

# ${role.name}

## Mandate
${role.desc}.

## Scope
This skill is loaded by \`${slugify(role.name)}_Agent\`, the autonomous
counterpart to the human **${role.name}** role in the ${role.area} function.
It should be invoked whenever a task in this Workflow phase needs the
judgment, terminology, or output format specific to this role.

## Inputs the agent should expect
- A task description or upstream artifact (spec, ticket, PR, design file, or
  prior agent's Blueprint) written to the shared Tier 0 Workspace
  (SQLite + R2) for this Workflow run.
- Relevant context fetched live via this role's MCP tools: ${
    cfg.mcp.length ? cfg.mcp.join(", ") : "none"
  }.

## What "done" looks like
1. Produce the artifact this role is accountable for (a spec, a diagram, a
   PR, a test report, a campaign brief, a contract redline — whatever
   "${role.desc.toLowerCase()}" implies in concrete form).
2. Self-score confidence (0–1) against a short rubric appropriate to the
   artifact type. Write both the artifact and the confidence score back to
   the Workflow's Durable Object state.
3. If confidence is below 0.70, or the task trips one of the org's fixed
   governance triggers (legal/compliance, budget > $10k, production
   incident, customer-facing comms, major architecture change), do **not**
   self-approve — pause the Workflow and route to the human owner instead
   of guessing.

## Escalation
- Confidence < 70% → sleep-until-signal, notify the human owner for this
  function via the Slack/Discord MCP tool.
- Anything matching a hard governance trigger → always escalate, regardless
  of confidence.

## Notes
- Runs at **${tierComment(cfg.tier)}**.
- Default model: \`${cfg.model}\` (swap via \`useModel()\` — Flue is
  model-agnostic; route through AI Gateway for caching/fallback/cost
  tracking).
`;
}

function buildAgentTs(role, cfg, isLeadership) {
  const roleFnName = pascal(role.name) + "Agent";
  const roleSlug = slugify(role.name);
  const skillVar = roleSlug.replace(/-/g, "_");
  // Tier 0 (workspace, no code execution) gets NO useSandbox call — the
  // agent runs model + skill + MCP tools only. Tier 1 / container roles run
  // locally under useSandbox(local()); the Cloudflare deploy target re-maps
  // these to isolates/containers via the vite flue() plugin config.
  const sandboxed = cfg.tier === "tier1" || cfg.tier === "container";
  const providerImport = providerImportFor(cfg.model);
  const mcpLines = cfg.mcp
    .map((m) => {
      // optional: true degrades gracefully (tools reported unavailable)
      // when a key or route for that server is missing, instead of
      // failing the run and retrying on the next message.
      const authVar = mcpAuthEnvFor(m);
      const auth = authVar ? `, auth: process.env.${authVar}` : "";
      return `useMcpConnection({ name: '${m}', url: '${mcpUrlFor(m)}'${auth}, optional: true });`;
    })
    .join("\n  ");

  const confidenceThreshold = isLeadership ? 0.8 : 0.7;

  return `// AUTO-GENERATED by scripts/generate-agents.mjs — do not hand-edit.
// Human role twin: "${role.name}" (${role.id}, ${role.area})
// ${role.desc}
'use agent';

import { useModel, ${
    sandboxed ? "useSandbox, " : ""
  }useSkill, useMcpConnection } from '@flue/runtime';${
    sandboxed ? "\nimport { local } from '@flue/runtime/node';" : ""
  }
import ${skillVar} from '../../skills/${roleSlug}/SKILL.md';${
    providerImport ? `\nimport '${providerImport}';` : ""
  }

/**
 * ${role.name}
 * Area: ${role.area}
 * Infra: ${tierComment(cfg.tier)}
 * Escalation: confidence < ${confidenceThreshold} or a governance trigger fires
 *             → Workflow sleeps and routes to the human owner of this function.
 */
export function ${roleFnName}() {
  useModel('${cfg.model}');${
    sandboxed ? "\n  useSandbox(local());" : ""
  }
  useSkill(${skillVar});
  ${mcpLines || "// no MCP servers bound for this role"}

  return \`You are the autonomous agent standing in for the human "${role.name}" role.
${role.desc}.
Confidence threshold for self-approval: ${confidenceThreshold}.
Below that threshold, or if a fixed governance trigger fires (legal, >$10k
budget, production incident, customer-facing comms, major architecture
change), pause and escalate to the human owner rather than proceeding.\`;
}

// Pinned durable identity: renaming the function later won't orphan the
// conversation storage keyed by agent name. The meta export is this
// repo's own bridge convention (consumed by scripts/run-agent.mjs),
// not Flue API.
${roleFnName}.agentName = '${roleSlug}';
export const meta = {
  id: '${role.id}',
  name: '${role.name}',
  area: '${role.area}',
  tier: '${cfg.tier}',
  confidenceThreshold: ${confidenceThreshold},
};
`;
}

async function main() {
  const roles = JSON.parse(
    await readFile(path.join(ROOT, "roles.json"), "utf8")
  );
  const areaConfig = JSON.parse(
    await readFile(path.join(ROOT, "area-config.json"), "utf8")
  );

  const registryEntries = [];
  const durableObjectBindings = [];
  const seenAreas = new Set();

  for (const role of roles) {
    const cfg = areaConfig[role.area];
    if (!cfg) {
      throw new Error(`No area-config entry for area: ${role.area}`);
    }
    const areaSlug = slugify(role.area);
    const roleSlug = slugify(role.name);
    const isLeadership = LEADERSHIP_RE.test(role.name);

    const agentDir = path.join(ROOT, "agents", areaSlug);
    const skillDir = path.join(ROOT, "skills", roleSlug);
    await mkdir(agentDir, { recursive: true });
    await mkdir(skillDir, { recursive: true });

    await writeFile(
      path.join(agentDir, `${roleSlug}.ts`),
      buildAgentTs(role, cfg, isLeadership)
    );
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      buildSkillMd(role, cfg)
    );

    registryEntries.push({
      id: role.id,
      area: role.area,
      name: role.name,
      importPath: `./agents/${areaSlug}/${roleSlug}.ts`,
      exportName: pascal(role.name) + "Agent",
      tier: cfg.tier,
    });

    if (!seenAreas.has(areaSlug)) {
      seenAreas.add(areaSlug);
      durableObjectBindings.push({ areaSlug, area: role.area });
    }
  }

  // registry.ts — single lookup table the orchestrator/Workflow uses to
  // resolve a role id to its live agent, mirroring the HTML's
  // "150+ agents across 20 functional areas" explorer. Statically imports
  // the agent functions (valid Flue: hooks only run at render, so importing
  // is side-effect free); plain-Node consumers must use registry.json
  // instead, because they cannot import .ts or SKILL.md.
  const registryTs = `// AUTO-GENERATED by scripts/generate-agents.mjs — do not hand-edit.
${registryEntries
  .map(
    (e, i) =>
      `import { ${e.exportName} as agent_${i}, meta as meta_${i} } from '${e.importPath}';`
  )
  .join("\n")}

export const AGENT_REGISTRY = {
${registryEntries
  .map((e, i) => `  '${e.id}': { agent: agent_${i}, meta: meta_${i} },`)
  .join("\n")}
};

export function getAgentByRoleId(id) {
  const entry = AGENT_REGISTRY[id];
  if (!entry) throw new Error(\`No agent registered for role id "\${id}"\`);
  return entry;
}
`;
  await writeFile(path.join(ROOT, "registry.ts"), registryTs);

  // registry.json — same map as plain JSON (file path + export name + meta)
  // for scripts/run-agent.mjs, which runs under plain Node and spawns
  // `flue run <file>` instead of importing the agent module itself.
  const registryJson = {};
  for (const e of registryEntries) {
    registryJson[e.id] = {
      file: e.importPath.replace(/^\.\//, ""),
      exportName: e.exportName,
      meta: {
        id: e.id,
        name: e.name,
        area: e.area,
        tier: e.tier,
      },
    };
  }
  await writeFile(
    path.join(ROOT, "registry.json"),
    JSON.stringify(registryJson, null, 2)
  );

  // wrangler.toml — one Durable Object namespace per functional area
  // (150 agents, 20 areas => 20 DO classes, each instantiated per-session),
  // plus the Workflows + Containers + AI Gateway bindings the HTML calls out.
  const wranglerToml = `# AUTO-GENERATED by scripts/generate-agents.mjs — do not hand-edit.
name = "flue-agent-org"
main = "src/worker.ts"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]

[ai]
binding = "AI"                     # Workers AI — 50+ open models

[[durable_objects.bindings]]
name = "AGENT_SESSION"
class_name = "AgentSessionDO"       # one instance per running agent session

${durableObjectBindings
  .map(
    (b) => `# Functional area: ${b.area}
[[durable_objects.bindings]]
name = "${b.areaSlug.toUpperCase().replace(/-/g, "_")}_DO"
class_name = "${pascal(b.area)}DO"
`
  )
  .join("\n")}

[[migrations]]
tag = "v1"
new_classes = [
  "AgentSessionDO",
${durableObjectBindings.map((b) => `  "${pascal(b.area)}DO",`).join("\n")}
]

[[workflows]]
binding = "SDLC_WORKFLOW"
name = "agentic-sdlc"
class_name = "SdlcWorkflow"

[[containers]]
name = "dev-sandbox"
image = "./containers/dev-sandbox/Dockerfile"
max_instances = 20                 # Tier-1 → Container escalation pool

[vars]
AI_GATEWAY_ID = "flue-agent-org-gateway"
GOVERNANCE_CONFIDENCE_FLOOR = "0.70"
GOVERNANCE_BUDGET_CEILING_USD = "10000"
`;
  await writeFile(path.join(ROOT, "wrangler.toml"), wranglerToml);

  // role-label-map.json — deterministic Linear-label -> role-id lookup used
  // by server/dispatch.mjs (see symphony-integration/). Generated here, not
  // hand-maintained, so it can't drift from roles.json on the next
  // `./skills.sh generate`.
  const roleLabelMap = {};
  for (const role of roles) {
    const areaSlug = slugify(role.area);
    const roleSlug = slugify(role.name);
    roleLabelMap[`role/${roleSlug}`] = {
      roleId: role.id,
      name: role.name,
      area: role.area,
      file: `agents/${areaSlug}/${roleSlug}.ts`,
    };
  }
  await writeFile(
    path.join(ROOT, "role-label-map.json"),
    JSON.stringify(roleLabelMap, null, 2)
  );

  console.log(`Generated ${registryEntries.length} agents across ${seenAreas.size} functional areas.`);
  console.log(`  agents/   — ${registryEntries.length} Flue agent .ts files`);
  console.log(`  skills/   — ${registryEntries.length} SKILL.md files`);
  console.log(`  registry.ts, registry.json, wrangler.toml, role-label-map.json written to project root.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
