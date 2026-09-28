#!/usr/bin/env node
// scripts/run-agent.mjs
//
// Runs ONE Flue agent for ONE issue and prints a JSON result to stdout.
// The agent executes via the real `flue run <file> -m <prompt> --json`
// CLI (@flue/cli): `flue run` owns the whole build — it resolves the .ts
// module, packages the SKILL.md import, registers the agent, dispatches
// one submission, and prints a JSON envelope on stdout (activity logs go
// to stderr). This file only resolves roleId -> agent file (via the
// plain-JSON registry.json, so it stays runnable under plain Node),
// spawns that CLI, and maps its envelope onto the bridge's result shape.
//
// Verified against @flue/runtime/@flue/cli 2.1.1, including the completed
// path (faux provider), the failed path (missing model credentials), and
// the tier1 shapes (useSandbox(local()) + optional useMcpConnection).
// A live model reply needs exactly one provider key in the environment
// (e.g. ANTHROPIC_API_KEY); without it `flue run` still proves module
// load, skill packaging, registration, and dispatch plumbing by failing
// with a structured auth error.
//
// Usage: echo '{"roleId":"6.2","prompt":"...","conversationId":"FLUE-123"}' \
//          | node scripts/run-agent.mjs
// Prints: {"ok":true,"result":{...}} or {"ok":false,"error":"...","detail":"..."}

import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const FLUE_BIN = path.join(
  ROOT,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "flue.cmd" : "flue"
);
const RUN_TIMEOUT_MS = Number(process.env.RUN_AGENT_TIMEOUT_MS || 120000);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `flue run --json` prints human-readable progress plus exactly one JSON
 * envelope line on stdout. Find the envelope: the last stdout line that
 * parses as an object with an `outcome` field.
 */
function findEnvelope(stdout) {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.outcome === "string") return obj;
    } catch {
      // not JSON — keep scanning
    }
  }
  return null;
}

function runFlue(agentFile, prompt, conversationId) {
  return new Promise((resolve, reject) => {
    const args = ["run", agentFile, "-m", prompt, "--json"];
    // Local secrets live in .dev.vars (gitignored, generated from pass) —
    // flue run auto-loads .env but not .dev.vars, so pass it explicitly.
    // Missing file simply means no local secrets: skip the flag.
    if (existsSync(path.join(ROOT, ".dev.vars"))) {
      args.push("--env", path.join(ROOT, ".dev.vars"));
    }
    // --id names (or continues) the conversation so follow-up dispatches
    // for the same Linear issue keep talking to the same agent instance.
    if (conversationId) args.push("--id", String(conversationId));
    const child = spawn(FLUE_BIN, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`flue run timed out after ${RUN_TIMEOUT_MS}ms (raise RUN_AGENT_TIMEOUT_MS)`)
      );
    }, RUN_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to spawn \`${FLUE_BIN}\`: ${err.message}. Is @flue/cli installed (pnpm install)?`
        )
      );
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    return fail("invalid_stdin_json", String(err?.message || err));
  }

  const { roleId, prompt, conversationId } = input;
  if (!roleId || typeof prompt !== "string") {
    return fail("invalid_input", "expected { roleId: string, prompt: string } on stdin");
  }

  let registry;
  try {
    registry = JSON.parse(await readFile(path.join(ROOT, "registry.json"), "utf8"));
  } catch (err) {
    return fail(
      "registry_read_failed",
      String(err?.message || err),
      "Regenerate with `node scripts/generate-agents.mjs`."
    );
  }

  const entry = registry[roleId];
  if (!entry) {
    return fail("unknown_role_id", `No agent registered for role id "${roleId}"`);
  }

  let run;
  try {
    run = await runFlue(entry.file, prompt, conversationId);
  } catch (err) {
    return fail("flue_spawn_failed", String(err?.message || err));
  }

  const envelope = findEnvelope(run.stdout);
  if (!envelope) {
    return fail(
      "flue_run_failed",
      `flue run exited (code=${run.code} signal=${run.signal}) without a JSON envelope. ` +
        `stdout=${run.stdout.slice(0, 500)} stderr=${run.stderr.slice(-1500)}`
    );
  }

  if (envelope.outcome === "completed") {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        result: {
          roleId: entry.meta.id,
          roleName: entry.meta.name,
          area: entry.meta.area,
          tier: entry.meta.tier,
          confidenceThreshold: entry.meta.confidenceThreshold,
          conversationId: envelope.id,
          text: envelope.message,
        },
      })
    );
    return;
  }

  if (envelope.outcome === "aborted") {
    return fail(
      "agent_aborted",
      envelope.error?.message || `run aborted (submission ${envelope.submissionId})`,
      run.stderr.slice(-1500)
    );
  }

  // outcome failed|error (auth errors, unreachable models, tool failures…)
  return fail(
    "agent_run_failed",
    envelope.error?.message || `run ended with outcome "${envelope.outcome}"`,
    run.stderr.slice(-1500)
  );
}

function fail(error, detail, hint) {
  process.stdout.write(JSON.stringify({ ok: false, error, detail, hint }));
  process.exitCode = 1;
}

main().catch((err) => {
  fail("unhandled_exception", String(err?.stack || err));
});
