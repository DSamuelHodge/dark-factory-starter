---
# NOT a replacement for Symphony's real elixir/WORKFLOW.md. That file is
# upstream's actual production workflow — it already handles the full
# Backlog -> Todo -> In Progress -> Human Review -> Merging -> Rework -> Done
# lifecycle, with `linear`, `commit`, `push`, `pull`, and `land` skills
# (the `land` skill specifically runs the merge loop; the agent is told
# never to call `gh pr merge` directly). Overwriting it with this file
# would delete all of that. This is a SEPARATE, triage-only workflow: run
# it as its own `symphony` process against its own project/label scope
# (or pass this path explicitly: `symphony path/to/WORKFLOW.flue.md`),
# alongside — not instead of — the real one.
tracker:
  kind: linear
  provider:
    project_slug: "$LINEAR_PROJECT_SLUG"
    api_key: "$LINEAR_API_KEY"
    # Only issues assigned to Symphony's own Linear bot user are candidates.
    # This is the adapter-derived `dispatchable` check from SPEC.md §4.1.1 —
    # not something the generic scheduler can infer on its own.
    assignee: "$LINEAR_BOT_USER_ID"
  # Symphony's Linear defaults (config/schema.ex) are already Todo/In Progress
  # as active and Closed/Cancelled/Done as terminal — left implicit here.
  required_labels: []   # deliberately empty: routing happens on role/* labels,
                         # inside the prompt+tool below, not via required_labels,
                         # so ONE Symphony instance can serve all 150 roles.

polling:
  interval_ms: 30000

agent:
  max_concurrent_agents: 10
  max_turns: 4          # this workflow's job is triage + one delegate call,
                         # not multi-turn implementation — keep it short.

codex:
  turn_timeout_ms: 600000
---

You are Symphony's Linear intake agent for {{ issue.identifier }}: {{ issue.title }}

{{ issue.description }}

This issue's labels: {{ issue.labels }}

Your job this turn:

1. If the labels include one starting with `role/`, call the
   `delegate_to_flue_agent` tool immediately. Do not attempt the work
   yourself first — the label names a specialist agent (one of 150 roles
   defined in flue-agent-org/roles.json) that should do it instead. Pass any
   extra clarifying context you have via the tool's optional `note` field.

2. If `delegate_to_flue_agent` succeeds, post its result as a comment on the
   issue via `linear_graphql` (an `issueCommentCreate` mutation), then move
   the issue to "In Review" if the delegate's response indicates it met its
   own confidence threshold, or leave it in its current state and add a
   `needs-human` label if it did not.

3. If `delegate_to_flue_agent` fails with `routing_failed` (no matching or
   ambiguous `role/*` label), do not guess which specialist this is for.
   Comment on the issue explaining that it needs exactly one `role/*` label
   before Symphony can route it, and stop.

4. If the issue has no `role/*` label at all, this workflow does not know
   what kind of work this is — comment asking a human to add one, and stop.
   Do not fall back to implementing the issue directly; that defeats the
   point of routing to a specialist agent with the right tools and sandbox
   tier for the job.
