---
name: save-agent
description: Create a new Agent workspace from a conversation. Use when the user message starts with "Skill: save-agent".
---

# Save Agent — Create Workspace from Conversation

## Input

The user message contains:
- `Workspace:` path — the pre-created workspace directory (has meta.json, empty memory/, skills/, tools/)
- `Conversation:` — formatted chat history between user and AI

## Your Task

Analyze the conversation and create these files in the workspace:

### 1. agent.md — AI personality

```markdown
# {Agent Name}

{Natural language: who this Agent is, what it's good at}

## Expertise
- ...

## Behavioral Preferences
- {observed style preferences from conversation}

## Work Style
- {collaboration patterns}
```

Use `write` to create `{workspace}/agent.md`.

### 2. me.md — User portrait

```markdown
# About the User

## Role
{profession/identity}

## Knowledge Level
{domain expertise level}

## Preferences
- {communication style}
- {content preferences}

## Habits
- {work patterns observed}
```

Use `write` to create `{workspace}/me.md`. Skip if conversation is too short to infer user traits.

### 3. memory/ — Domain knowledge

For each piece of domain knowledge worth preserving, write a file:

```markdown
---
name: topic_name
description: One-line summary
type: project
scope: global
created: {ISO timestamp}
updated: {ISO timestamp}
---

{Knowledge content}
```

Use `write` to create `{workspace}/memory/{name}.md`.

### 4. skills/ — Reusable workflows

Look for repeatable patterns in the conversation:
- Multi-step procedures the AI executed more than once
- Explicit user instructions like "always do it this way"
- Tool call sequences that form a workflow

For each pattern, create a skill:

```markdown
---
name: skill-name
description: When to trigger this skill
---

# Skill Title

## Steps
1. ...
2. ...
```

Use `write` to create `{workspace}/skills/{name}/SKILL.md`.

**Complexity rules:**
- Simple (text-only workflow) → just SKILL.md
- Medium (workflow + reference docs) → SKILL.md + `references/{name}.md`
- Complex (workflow + executable scripts) → SKILL.md + `scripts/{name}.py` + `references/`

Most conversations will have 0-1 skills. Don't force it.

### 5. tools/config.json — Tool dependencies

Scan the conversation for tool usage:
- `mcp_execute` calls → extract which MCP servers were used (server names from `tools.search()` / `tools.call()` results)

Read existing `{workspace}/tools/config.json`, then `edit` to add:

```json
{
  "workingDir": "...",
  "mcpServers": ["sequential-thinking", "fetch"],
  "cliTools": []
}
```

- `mcpServers`: MCP server names used in the conversation (empty array = no MCP dependency)
- `cliTools`: leave existing values unchanged; the unattended Evolver has no shell
- Only add if the conversation actually used these tools. Don't guess.

### 6. tasks/ — Carry over scheduled tasks (任务迁移)

The user may have created scheduled/webhook tasks during this conversation (via the `manage_task` tool). When saving the conversation as an Agent, these tasks should follow the Agent — not stay orphaned in the source conversation.

**Find candidates.** The user message includes a `Candidate tasks to migrate` section pre-filtered by the system. **Use that list as your authoritative source — do not re-derive candidates from the conversation text** (the conversation has been stripped to plain text and does not contain `manage_task` tool call details, so you cannot reliably extract task IDs from it).

The list contains entries like:
```
- <task-uuid>  | name: <task name>  | created: <ISO timestamp>  | match: exact conversation binding
```

Only tasks whose stored `boundConversationId` exactly matches the source
conversation can appear here. Unbound tasks and tasks from another conversation
must never be inferred from timestamps or conversation text.

Treat every entry as a migration target unless the conversation clearly asks for a copy. Use only the `migrate_candidate_task` tool: it checks whether the file still exists and whether it belongs to another Agent without exposing the task JSON or webhook secret.

If the candidate list says `(none)`, **skip section 6 entirely** — no work to do.

**Default action: MIGRATE** (move task to the new Agent). Call `migrate_candidate_task` with the exact candidate `taskId` and `action: "migrate"`. The tool preserves trigger, prompt, webhook credentials, and scheduling fields internally while changing only the Agent binding.

**Exception: COPY** (keep original, create a duplicate for the new Agent). Only when the conversation explicitly asks to keep/reuse it, call `migrate_candidate_task` with the exact candidate `taskId` and `action: "copy"`.

Never use `read`, `grep`, `find`, `ls`, `bash`, or code execution on the application tasks directory. Task files can contain webhook credentials; the capability-scoped migration tool is the only permitted path.

**Skip this step entirely** if no task files match the source conversation. Most short conversations won't have tasks.

### 7. meta.json — Update identity

Read the existing meta.json, then update name, icon, and description:

```json
{
  "name": "2-6 character Agent name",
  "icon": "relevant emoji",
  "description": "one-line description (≤15 chars)"
}
```

Use `read` then `edit` to update `{workspace}/meta.json`.

## Order of operations

1. Read the conversation carefully
2. Write agent.md (always)
3. Write me.md (if enough signal)
4. Write memory files (domain knowledge)
5. Write skill files (reusable patterns)
6. Update tools/config.json (if tools were used)
7. Migrate scheduled tasks (if any match — see section 6 above)
8. Update meta.json name/icon/description
