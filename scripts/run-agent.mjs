#!/usr/bin/env -S npx tsx
// scripts/run-agent.mjs
//
// Runs ONE Flue agent for ONE issue and prints a JSON result to stdout.
// Deliberately a separate process from server/dispatch.mjs, executed via
// `npx tsx` (not plain node), because registry.ts imports agents/*.ts files
// with explicit .ts extensions and a `with { type: 'skill' }` import
// attribute for SKILL.md — plain node's --experimental-strip-types cannot
// resolve either of those. tsx (esbuild-backed) can load real TypeScript;
// whether it also honors that custom `skill` import attribute depends on
// what @flue/runtime's own loader hook does, which is UNVERIFIED here (see
// below). Isolating this into a subprocess means a bad import or a wrong
// runtime API guess crashes *this process* with a clear stderr message,
// not the whole dispatch server.
//
// Usage: echo '{"roleId":"6.2","prompt":"..."}' | npx tsx scripts/run-agent.mjs
// Prints: {"ok":true,"result":{...}} or {"ok":false,"error":"...","detail":"..."}

import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    return fail("invalid_stdin_json", String(err?.message || err));
  }

  const { roleId, prompt } = input;
  if (!roleId || typeof prompt !== "string") {
    return fail("invalid_input", "expected { roleId: string, prompt: string } on stdin");
  }

  let registry;
  try {
    // Real import of the generated registry — this DOES require tsx (or an
    // equivalent TS loader) to be resolvable; running this file with plain
    // `node` instead of `npx tsx` will fail here with an ERR_UNKNOWN_FILE_EXTENSION
    // or similar, which is expected and is why dispatch.mjs never does this
    // import itself.
    registry = await import(path.join(ROOT, "registry.ts"));
  } catch (err) {
    return fail(
      "registry_import_failed",
      String(err?.message || err),
      "Run this file with `npx tsx`, not plain `node`. Also confirm @flue/runtime is installed."
    );
  }

  let entry;
  try {
    entry = registry.getAgentByRoleId(roleId);
  } catch (err) {
    return fail("unknown_role_id", String(err?.message || err));
  }

  // --- UNVERIFIED FROM HERE DOWN -----------------------------------------
  // Everything above this line (registry loading, role lookup) is real and
  // tested. The three calls below — agent.init(), harness.session(),
  // session.prompt() — are a GUESS at @flue/runtime's actual public API,
  // based only on the `createAgent()` shape used in scripts/generate-agents.mjs.
  // This has not been run against a real @flue/runtime package. Treat this
  // block as a skeleton to correct once you've read that package's actual
  // exports, not as verified behavior.
  try {
    const harness = await entry.agent.init();
    const session = await harness.session();
    const response = await session.prompt(prompt);

    process.stdout.write(
      JSON.stringify({
        ok: true,
        result: {
          roleId: entry.meta.id,
          roleName: entry.meta.name,
          area: entry.meta.area,
          tier: entry.meta.tier,
          confidenceThreshold: entry.meta.confidenceThreshold,
          text: response.text,
        },
      })
    );
  } catch (err) {
    return fail(
      "agent_run_failed",
      String(err?.message || err),
      "agent.init()/harness.session()/session.prompt() is an UNVERIFIED guess at " +
        "@flue/runtime's API — check that package's actual exports and fix this file."
    );
  }
}

function fail(error, detail, hint) {
  process.stdout.write(JSON.stringify({ ok: false, error, detail, hint }));
  process.exitCode = 1;
}

main().catch((err) => {
  fail("unhandled_exception", String(err?.stack || err));
});
