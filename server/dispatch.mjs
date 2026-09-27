#!/usr/bin/env node
// server/dispatch.mjs
//
// Small HTTP bridge so Symphony (Elixir, one process per Linear project) can
// hand an issue off to the correct Flue agent (Node/TypeScript, this repo)
// without the two runtimes sharing a process.
//
// Role selection is a deterministic lookup, not an LLM guess:
//   Linear label (e.g. "role/frontend-developer") -> role-label-map.json -> role id
//
// This process is PLAIN Node — it never imports registry.ts or any agent
// .ts file directly, because registry.ts uses explicit .ts import
// extensions and a `with { type: 'skill' }` import attribute for SKILL.md
// that plain node cannot resolve. The actual agent run happens in a
// subprocess (scripts/run-agent.mjs) executed via `npx tsx`, which keeps
// that unverified TS/loader surface from ever crashing this HTTP server.
//
// Run:
//   npm install @flue/runtime           # the actual agent runtime this calls
//   npm install -D tsx                  # runs run-agent.mjs's real TS imports
//   node server/dispatch.mjs            # listens on DISPATCH_PORT (default 4001)
//
// Port note: default is 4001, not 4000 — 4000 is the example dashboard port
// used throughout Symphony's own test fixtures (e.g.
// test/symphony_elixir/orchestrator_status_test.exs), so it's the port a
// dev is likely to reach for if they configure `server.port` in their own
// WORKFLOW.md. Not a hardcoded collision (Symphony's dashboard has no
// default port and won't start unless `server.port` is set — see
// config/schema.ex), but a likely one if you set one, so we sidestep it.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const PORT = Number(process.env.DISPATCH_PORT || 4001);
// Bind loopback only — this bridge trusts its caller (the local Symphony
// process) and does no auth of its own. Do not expose this port publicly.
const HOST = process.env.DISPATCH_HOST || "127.0.0.1";
const AGENT_RUN_TIMEOUT_MS = Number(process.env.DISPATCH_AGENT_TIMEOUT_MS || 120000);
// Timeout note: the Elixir side allows 120s (Req receive_timeout) and Codex
// turns allow 600s. Container-tier roles (dev/QA/security) routinely exceed
// 120s — raise DISPATCH_AGENT_TIMEOUT_MS (e.g. 600000) for those, or the
// bridge returns agent_subprocess_failed while the agent is still running.
// Windows note: spawn needs npx.cmd on win32; plain "npx" only works on
// macOS/Linux.
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

let labelMap;

async function loadLabelMap() {
  if (!labelMap) {
    labelMap = JSON.parse(
      await readFile(path.join(ROOT, "role-label-map.json"), "utf8")
    );
  }
  return labelMap;
}

/**
 * Resolve which Flue role a Linear issue's labels map to.
 * Deterministic: first label (lowercased, trimmed — Symphony already
 * normalizes labels this way per its Issue model) that matches an entry in
 * role-label-map.json wins. No model call, no guessing.
 */
function resolveRoleId(labels, map) {
  const matches = (labels || [])
    .map((l) => String(l).trim().toLowerCase())
    .filter((l) => map[l]);

  if (matches.length === 0) {
    return { ok: false, reason: "no_role_label", checked: labels || [] };
  }
  if (matches.length > 1) {
    // Ambiguous routing is a config problem, not a judgment call — surface
    // it rather than silently picking one.
    return {
      ok: false,
      reason: "ambiguous_role_labels",
      matched: matches.map((l) => map[l].roleId),
    };
  }
  return { ok: true, roleId: map[matches[0]].roleId, label: matches[0] };
}

/**
 * Run scripts/run-agent.mjs under `npx tsx` as a subprocess, feed it
 * { roleId, prompt } on stdin, and parse its single-line JSON stdout.
 * Isolates the entire unverified @flue/runtime call chain from this process.
 */
function runAgentSubprocess(roleId, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(NPX, ["tsx", path.join(ROOT, "scripts", "run-agent.mjs")], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`run-agent.mjs timed out after ${AGENT_RUN_TIMEOUT_MS}ms`));
    }, AGENT_RUN_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn \`npx tsx\`: ${err.message}. Is tsx installed (npm install -D tsx)?`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(
          new Error(
            `run-agent.mjs did not print valid JSON. stdout=${stdout.slice(0, 500)} stderr=${stderr.slice(0, 500)}`
          )
        );
      }
    });

    child.stdin.write(JSON.stringify({ roleId, prompt }));
    child.stdin.end();
  });
}

async function handleDispatch(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return sendJson(res, 400, { error: "invalid_json_body" });
  }

  const { issue } = body;
  if (!issue || !Array.isArray(issue.labels)) {
    return sendJson(res, 400, {
      error: "invalid_request",
      detail: "expected { issue: { labels: [...], identifier, title, description, url, ... } }",
    });
  }

  const map = await loadLabelMap();
  const resolution = resolveRoleId(issue.labels, map);
  if (!resolution.ok) {
    // 422, not 500: this is "we couldn't route it," which the workflow
    // prompt should treat as "leave a comment and hand off," not a
    // retryable server error.
    return sendJson(res, 422, { error: "routing_failed", ...resolution });
  }

  const taskPrompt = [
    `Linear issue ${issue.identifier}: ${issue.title}`,
    issue.description || "",
    issue.url ? `URL: ${issue.url}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  let agentResult;
  try {
    agentResult = await runAgentSubprocess(resolution.roleId, taskPrompt);
  } catch (err) {
    return sendJson(res, 500, {
      error: "agent_subprocess_failed",
      roleId: resolution.roleId,
      detail: String(err?.message || err),
    });
  }

  if (!agentResult.ok) {
    // Distinguish "the plumbing is broken" (missing deps, bad import) from
    // "the agent itself failed" so a human debugging this can tell which
    // half to look at.
    const status = agentResult.error === "unknown_role_id" ? 404 : 502;
    return sendJson(res, status, { matchedLabel: resolution.label, ...agentResult });
  }

  return sendJson(res, 200, { matchedLabel: resolution.label, ...agentResult.result });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/dispatch") {
    handleDispatch(req, res).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: "internal_error", detail: String(err?.message || err) });
    });
    return;
  }
  if (req.method === "GET" && req.url === "/healthz") {
    return sendJson(res, 200, { ok: true });
  }
  sendJson(res, 404, { error: "not_found" });
});

server.listen(PORT, HOST, () => {
  console.log(`flue dispatch bridge listening on http://${HOST}:${PORT}`);
  console.log(`  POST /dispatch   { issue: { labels, identifier, title, description, url } }`);
  console.log(`  GET  /healthz`);
});
