---
name: dream
description: Evolve an existing Agent workspace based on recent conversations. Use when the user message starts with "Skill: dream".
---

# Dream — Evolve Agent Workspace

## Input

The user message contains:
- `Target workspace:` path — the Agent workspace to evolve
- `Recent conversations:` — formatted chat history since last dream

## Your Task

### Phase 1: Orient

Use `ls` and `read` to inspect the target workspace:
- Read `agent.md` — current personality
- Read `me.md` — current user portrait
- List `memory/` — existing memories
- List `skills/` — existing skills

### Phase 2: Analyze

Review the recent conversations and decide what needs updating:

**agent.md updates** — Has the Agent's role or work style evolved? Are there new expertise areas?
**me.md updates** — Has the user revealed new preferences, knowledge, or habits?
**memory/ updates:**
- New knowledge worth preserving → `write` new memory file
- Outdated content → `edit` to update it. Do NOT delete a memory just because it looks old or no longer relevant — the system automatically archives stale memories (moves them to `archive/`, fully reversible). Your job is consolidation, not forgetting by age.
- Duplicate memories → merge all valuable details into one existing file; do not delete files (the system owns archival)
**skills/ updates:**
- New repeatable patterns → create new skill
- Existing skill needs refinement → `edit` the SKILL.md
**tools/config.json updates:**
- Scan for `mcp_execute` calls → add new MCP server names to `mcpServers` array
- Only add tools that were actually used, don't remove existing entries (accumulated over time)

### Phase 3: Execute

Apply changes using `write`, `edit`, `grep`, and `read`:
- Use `grep` to find related memories before creating duplicates
- Use `edit` for surgical updates to existing files
- Use `write` for new files

## Rules

- Be conservative: don't change what's working. Only update when there's clear signal.
- Never delete agent.md or me.md — only update them.
- **Forgetting is the system's job, not yours.** The system deterministically archives stale, non-core memories (old `project`/`reference`/untyped) after you finish — reversibly, into `archive/`. Identity (`user`) and working-style (`feedback`) memories are never auto-archived. So you never need to delete memories for being old; just consolidate.
- When merging memories, preserve all valuable details from both sources.
- Convert relative dates to absolute dates in memory content.
- Keep skill descriptions focused on WHEN to trigger, not WHAT the skill does (the body handles that).
