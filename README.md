# continuity

A Claude Code plugin that keeps a long session's sense of continuity across context compaction.

When a conversation fills the context window, Claude Code compacts it: everything so far is replaced by one summary. A summary keeps *what* happened and tends to lose *why*: the reasons behind decisions, the options turned down, the open threads, the feel of the collaboration. This plugin adds three things around every compaction of the main conversation:

1. **A handoff note, written with everything still in view.** Just before the compaction, a fork of the session (the session's own model, over its own transcript, served from the prompt cache) writes a note to itself:
   - where we are;
   - decisions and why;
   - open threads;
   - how the user works;
   - the feel of it;
   - where to look.

   Each note is saved under `~/.claude/continuity/<session id>/`.
2. **Standing instructions for the summariser**, for automatic compactions too: keep decisions with their reasons, the options rejected, every open thread and the current state. They come after anything typed after `/compact`.
3. **The note comes back right after the summary**, as Claude's own message. It carries the path of the session's full transcript, which keeps everything from before the compaction, so details can be looked up there.

`/handoff` writes a note on demand, without compacting: a checkpoint you can read.

If anything fails (there is nothing to fork yet, the model doesn't answer, an error), the compaction is Claude Code's own, as if the plugin weren't there. A subagent's own compactions pass through untouched.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install continuity --marketplace gabriel-berzescu/claude-continuity
```

Answer `y` to add the marketplace, then pick a scope (user, so it runs in every session). From a shell, use `claude plugin install continuity --marketplace gabriel-berzescu/claude-continuity`. In the desktop app, where `/plugin` does not run, click + next to the prompt box, then Plugins, Add marketplace with `gabriel-berzescu/claude-continuity`, then Add plugin.

While developing, load it from a working copy instead: `claude --plugin-dir <path to this folder>`, or name the folder in `CLAUDE_CODE_PLUGIN_DIRS`.

It is a hooks module (a "mod"), built on Claude Code's early-access function-hooks API, and tested with Claude Code 2.1.310.

## Goes well with

- A **Compact instructions** section in your `CLAUDE.md`. The compactor reads it, and the heading is free-form. Say what to keep: decisions and reasons, open threads, state, the collaboration's tone.
- A larger auto-compact window (`/autocompact`), so compaction happens rarely, and `"idleCompaction": false` in your settings if you don't want a session compacted while it sits idle.

## What it costs

At each compaction, one extra model request over the transcript (mostly read from the prompt cache) and a note of about 1,500 words. `/handoff` costs the same.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

`tests/continuity.test.ts` stands in for the engine: the fork, the files, the compaction. A live check: run a short session with `claude -p --input-format stream-json --plugin-dir .`, send a few messages, then `/handoff`, `/compact` and a question that needs what was said before.

## License

MIT
