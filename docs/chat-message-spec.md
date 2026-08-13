# Chat Message Spec v2

## Goals

- Support multi-stage agent flows without relying on completion time for ordering.
- Keep existing UX intact: secondary thinking display, streaming text, realtime visualizer preview, loading shimmer, and normal assistant/user bubbles.
- Make new message types additive instead of adding more ad hoc conditionals across the store and UI.
- Keep model context clean: UI-only messages must not be sent back to the model.

## Core Model

Each persisted message keeps the legacy fields (`role`, `content`, `toolName`, etc.) for compatibility, and adds typed metadata:

- `messageVersion`: schema version. Current value is `2`.
- `messageKind`: semantic kind used for normalization and rendering.
- `messageSubtype`: optional refinement for styling or tool-specific behavior.

Current kinds:

- `user`
- `assistant`
- `thinking`
- `tool`
- `permission_request`
- `ask_user`
- `voice`

## Ordering Rules

Messages are ordered by stage anchor, not by final completion time.

Rules:

1. When assistant text is flushed, create an `assistant` message immediately.
2. When only thinking exists, create a `thinking` message immediately.
3. When a tool starts, create a hidden `tool` anchor message immediately.
4. Tool completion updates the existing tool anchor instead of creating a second floating message.
5. Follow-up assistant text is appended after the tool anchor.

This gives stable sequences such as:

1. `thinking`
2. `assistant`
3. `tool`
4. `assistant`
5. `thinking`
6. `tool`

## Rendering Rules

Rendering is based on `messageKind`, not on fragile combinations of optional fields.

- `user`: standard user bubble.
- `assistant`: standard assistant bubble, optionally with collapsible `thinkingContent`.
- `thinking`: standalone collapsible thinking card.
- `tool`: tool card, screenshot card, search result card, document card, code card, file card, or visualizer embed.
- `permission_request`: inline approval card.
- `ask_user`: assistant bubble plus choice buttons or form.

Pending tool anchors are valid messages, but they are not rendered until they have a visible payload.

## Model Context Rules

Only messages that represent user-visible conversation text should be sent back to the model.

Allowed into model context:

- `user`
- `assistant`
- `ask_user`
- `voice` when it contains transcript text

Blocked from model context:

- `thinking`
- `tool`
- `permission_request`

This prevents internal reasoning, visualizer payloads, permission UI, and hidden anchors from polluting subsequent turns.

## Persistence Rules

The persisted conversation schema remains append-only and backward compatible.

- Old records without `messageKind` are normalized on read.
- New writes always persist `messageVersion` and `messageKind`.
- Tool anchors may be persisted while a stream is active; if a session ends unexpectedly, they remain hidden unless they later get a visible payload.

## Extension Checklist

Every new message type must define the following:

1. `messageKind`
2. insertion anchor
3. whether it is persisted
4. whether it is sent back to the model
5. render component
6. transcript/export behavior
7. conversation preview behavior
8. regenerate eligibility

If any of these are undefined, the type is not ready to ship.

## Current Mapping

- Secondary thinking display: `thinking` or `assistant + thinkingContent`
- Visualizer streaming preview: transient store-only preview during generation
- Visualizer final result: persisted `tool` message with `visualizerHtml`
- Loading shimmer / tool progress: transient UI state, not persisted message content

## Migration Strategy

This spec is introduced first in the renderer/store layer.

- Main process storage stays compatible.
- Existing IPC/event protocol stays intact.
- Renderer normalizes old and new records into the v2 message model.

If future message types grow substantially, the next step is to lift `messageKind` into the main process event protocol itself. For now, renderer-side normalization is sufficient and low risk.
