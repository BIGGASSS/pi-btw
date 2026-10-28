<div align="center">

<img src="https://cdn.jsdelivr.net/gh/L2ncE/pi-btw@main/assets/logo.png" alt="pi-btw" width="280"/>

**`/btw` for [pi](https://pi.dev) — ask while it works.**

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/L2ncE/pi-btw/actions/workflows/ci.yml/badge.svg)](https://github.com/L2ncE/pi-btw/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)

[中文说明](README_zh.md)

</div>

## What Is This

The main agent is elbow-deep in a refactor, and a random question pops into
your head — *what was that config file called?* Until now you either
interrupted the run or opened another terminal.

`/btw` answers it in a floating overlay while the main agent keeps running:

```
/btw what was that config file called?
/btw what does this error actually mean?
```

Inspired by Claude Code's `/btw`, rebuilt natively for pi:

- the answer streams into a **top-center overlay**; the main view keeps moving
- **never** enters the main conversation or its context window
- the side agent sees the main session's real messages, and remembers your
  earlier side questions — up to 20 exchanges
- **read-only tools** (`read` / `grep` / `find` / `ls`): it can inspect the
  repo itself, but cannot touch anything
- follow-ups typed straight into the overlay continue the same side thread
- side-agent token usage and costs count toward the main session's totals;
  questions and answers still stay out of its context

![pi-btw in action](https://cdn.jsdelivr.net/gh/L2ncE/pi-btw@main/assets/screenshot.png)

## Install

Requires **pi 1.4.0 or newer** for native usage accounting.

```bash
pi install npm:@lanlance/pi-btw
```

or via git:

```bash
pi install git:https://github.com/L2ncE/pi-btw
```

or try without installing:

```bash
pi -e /path/to/pi-btw
```

## Usage

Type `/btw <question>` at any time — including while the main agent is
mid-task (pi runs extension commands immediately instead of queueing them).

Overlay keys:

| Key | Action |
|---|---|
| `Enter` | submit the follow-up in the input |
| `Esc` | abort while answering; close when idle |
| `c` | copy the current answer (raw markdown) to the clipboard |
| `←` / `→` | page through this session's side Q&A history |
| `↑` / `↓` | scroll a long answer |
| `Alt+/` | toggle focus between the overlay and the main editor (overlay stays visible; `Ctrl+Alt+W` as fallback) |

Earlier questions appear as a dimmed list above the current answer. The side
thread lives in memory only — `/new`, restarts and reloads clear it, and none
of the Q&A ever reaches the main conversation.

### Usage and costs

`/btw` appends accounting-only `usage` entries (`kind: "btw"`) to the main
session journal. The normal footer and `/session` totals include these tokens
and costs, and they survive resuming a saved session. Each side-agent response
is counted once, including tool turns, compaction, and any usage reported for
errors or aborts. Seeded main-session history is not counted again.

Only usage and model attribution are recorded, never side questions, answers,
or tool output. Prices come from the side agent's reported usage, even when it
uses a different model from the main agent.

Pi's normal persistence rules apply: an in-memory main session does not write
a file, and a brand-new session used only for `/btw` delays file creation until
the first main-conversation message. Until then its usage totals are in memory.

## Configuration

By default the side agent uses the main session's model and thinking level.
To pin a different model, create `~/.pi/agent/btw.json`:

```json
{
	"model": "openai/gpt-5.2",
	"thinking": "low"
}
```

- `model` — `provider/modelId`, or a bare model id when it is unambiguous
  across providers
- `thinking` — optional: `off` / `minimal` / `low` / `medium` / `high` /
  `xhigh` / `max`; when omitted, the main session's thinking level is used
- the file is re-read before every ask, so edits apply without a restart
- an invalid config is reported and the question is dropped — it never
  silently falls back
- delete the file (or empty the `model` field) to follow the main session
  again

The overlay title shows the model the side agent is currently using.

## Design

- one lazily-created in-memory `AgentSession` sub-session per pi session
  (`SessionManager.inMemory()`, no side-conversation file), seeded by writing
  the main session's messages (`buildSessionContext` + `convertToLlm`) into the
  sub-session journal before creation — `createAgentSession` restores them
  through its own path, so they also survive compaction rebuilds
- new usage-bearing child journal entries are forwarded to the main manager's
  native `appendUsage()`; unlike custom extension entries, these feed pi's
  built-in totals without changing model context. This uses a narrowly guarded
  SDK access to the manager because extension contexts expose it as read-only
- shutdown aborts and drains the child before disposing it, so late usage is
  attributed to the original session rather than a replacement
- tool whitelist `["read", "grep", "find", "ls"]` — no bash, no edit, no write
- model and thinking level follow the main session unless pinned via
  `~/.pi/agent/btw.json`; a pinned model is never re-synced to the main
  session's, and the sub-session runs on in-memory settings so its model
  switches never touch the user's global pi settings
- the system prompt is composed fresh by the sub-session from the main
  session's raw `customPrompt` and `appendSystemPrompt` (via
  `getSystemPromptOptions()`) plus the btw role prompt; context files and
  skills load from disk at first `/btw`, and the tools section lists exactly
  the four read-only tools
- the system prompt tells the side agent exactly what it is: temporary,
  read-only, never promises actions

## License

Apache-2.0
