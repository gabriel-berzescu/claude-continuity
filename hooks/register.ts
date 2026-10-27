/**
 * continuity: a long session keeps its sense of continuity across context compaction.
 *
 * Compaction replaces the conversation with one summary, which keeps what happened and tends to lose why: the reasons behind
 * decisions, the options turned down, the open threads, the feel of the collaboration. This mod adds three things around it:
 *
 *   1. Just before a compaction, Claude itself writes a handoff note: a fork of the session (`$.model.fork`, the session's own
 *      model over its own transcript, served from the prompt cache) still sees the whole conversation and answers HANDOFF_PROMPT.
 *      The note is saved under ~/.claude/continuity/<session id>/. Its "In our own words" section quotes a few exchanges word
 *      for word, to keep the texture a description loses; each quoted line is checked against the conversation (checkWords)
 *      and left out if its words are not there.
 *   2. The summariser is told what to keep (SUMMARY_INSTRUCTIONS), also for automatic compactions, after any instructions typed
 *      after /compact.
 *   3. Right after the summary, the note goes back into the conversation as Claude's own message, with the path of the full
 *      transcript (which keeps everything from before the compaction) so details can be looked up there.
 *
 * `/handoff` writes a note on demand without compacting.
 *
 * Only the main conversation is handled (a subagent's own compactions pass through). A `precompute` (a summary computed ahead
 * of time and kept for the next compaction) passes through too: the note is written at the compaction that installs it.
 * Anything that fails falls back to the engine's own compaction: this mod never stands between the session and its summary.
 */
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

const HANDOFF_PROMPT = `The conversation above is about to be compacted: everything before this point will be replaced by a summary. You still see all of it. Write the handoff note you will read right after the compaction, so the session goes on as the same collaboration rather than a fresh start from a summary.

Write it in the first person, as notes to yourself, in plain markdown, at most about 1800 words, with exactly these sections:

## Where we are
The current task, its state, what is done / committed / pushed / only local, running helpers or processes (what each does, how it reports), and the next step agreed with the user.

## Decisions and why
Each decision with its reason and who made it, the options turned down and why. Quote the user's own short words where they matter.

## Open threads
Promises made, questions waiting on the user, things to check, anything left half done.

## How the user works
Preferences, taste and corrections voiced in this session; lessons learned the hard way (keep the lesson, not the attempt).

## The feel of it
The tone between us, running jokes, what the user enjoyed, how to keep sounding like the same collaborator.

## In our own words
Six to ten short exchanges copied word for word from the conversation, so you meet the actual voices again rather than a description of them. Pick the moments that carry its texture: decisions, corrections, delight, jokes, turning points. Copy the user's words exactly as typed, typos and emoji included, and add your own reply where it matters: the sentence that carries its point, not just its opening. Trim a long message with "…", never reword it: each line is checked against the conversation and left out if its words are not there. One line per message, a blank line between exchanges:
> **<the user's name, or User>:** their words
> **Me:** your words

## Where to look
Details worth looking up in the full transcript rather than carrying here (exact quotes, numbers, long lists, file contents), each with a few words to search for.

Leave out raw tool output, file contents, step-by-step logs and anything the repository or git history already records. Start directly with the first heading.`

const SUMMARY_INSTRUCTIONS = `Keep the user's decisions together with their reasons, the options rejected and why, every open thread (running helpers or background tasks, questions waiting on the user, promises, the agreed next steps) and the current state of the work. A separate handoff note, written with the whole conversation in view, is attached after this summary.`

type Paths = { dir: string; transcript: string | undefined }

const slug = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-')

/** Joins path parts with the separator the base already uses (backslashes on Windows), so the paths shown read cleanly. */
const join = (base: string, ...parts: string[]) => [base.replace(/[\\/]+$/, ''), ...parts].join(base.includes('\\') ? '\\' : '/')

async function claudeDir($: EngineInterface): Promise<string> {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configured) return configured.replace(/[\\/]+$/, '')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~'
  return join(home, '.claude')
}

/** Where this session's notes go, and its transcript file (found where Claude Code keeps it, or undefined). */
async function paths($: EngineInterface): Promise<Paths> {
  const [base, id] = await Promise.all([claudeDir($), $.session.id()])
  const dir = join(base, 'continuity', id)
  const projects = join(base, 'projects')
  const candidates = [await $.session.cwd(), await $.session.root()].map((p) => join(projects, slug(p), `${id}.jsonl`))
  for (const c of candidates) if (await $.fs.exists(c)) return { dir, transcript: c }
  try {
    for (const entry of await $.fs.list(projects)) {
      const c = join(projects, entry.name, `${id}.jsonl`)
      if (await $.fs.exists(c)) return { dir, transcript: c }
    }
  } catch {
    // no projects folder: leave the transcript unnamed
  }
  return { dir, transcript: undefined }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

/**
 * Text folded for matching quotes: case, curly quotes and dashes, runs of white space, and markdown's * ` _ marks, which a
 * quote may lose. `at[i]` is where folded character i came from, so a match maps back to the original words.
 */
type Folded = { text: string; at: number[] }

const FOLD: Record<string, string> = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '‟': '"', '—': '--', '–': '-' }

function fold(s: string): Folded {
  let text = ''
  const at: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (/\s/.test(c)) {
      if (text && !text.endsWith(' ')) {
        text += ' '
        at.push(i)
      }
    } else if (c !== '*' && c !== '`' && c !== '_') {
      for (const f of (FOLD[c] ?? c).toLowerCase()) {
        text += f
        at.push(i)
      }
    }
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1)
    at.pop()
  }
  return { text, at }
}

type Source = { role: SessionMessage['role']; text: string; folded: Folded }

const ELLIPSIS = /\s*(?:…|\.{3,})\s*/

/**
 * The quote as the conversation has it: each part between the quote's "…" found in order in one message, mapped back to that
 * message's own characters (the gap between two parts kept when it is short, else "…"). Undefined when no message holds it.
 */
function verbatim(quote: string, sources: readonly Source[]): string | undefined {
  const parts = quote.split(ELLIPSIS)
  const wanted = parts.map((p) => fold(p).text).filter(Boolean)
  if (!wanted.length) return undefined
  const lead = parts[0]!.trim() ? '' : '…'
  const tail = parts.length > 1 && !parts[parts.length - 1]!.trim() ? '…' : ''
  for (const m of sources) {
    const spans: [number, number][] = []
    let from = 0
    for (const w of wanted) {
      const i = m.folded.text.indexOf(w, from)
      if (i < 0) break
      spans.push([m.folded.at[i]!, m.folded.at[i + w.length - 1]! + 1])
      from = i + w.length
    }
    if (spans.length < wanted.length) continue
    const words = spans.map(([a, b], k) => {
      const gap = k ? m.text.slice(spans[k - 1]![1], a) : ''
      return (gap.length <= 6 ? gap : ' … ') + m.text.slice(a, b)
    })
    return (lead + words.join('') + tail).replace(/\s+/g, ' ').trim()
  }
  return undefined
}

const WORDS_HEADING = /^##\s+In our own words[ \t]*$/im

type Quotes = { found: number; total: number }

/**
 * Checks the note's "In our own words" lines against the conversation: a line found there is kept with the conversation's own
 * characters, one that is not is left out, and a closing line says how many were found.
 */
function checkWords(note: string, messages: readonly SessionMessage[]): { text: string; quotes: Quotes } {
  const quotes = { found: 0, total: 0 }
  const head = WORDS_HEADING.exec(note)
  if (!head) return { text: note, quotes }
  const start = head.index + head[0].length
  const next = note.slice(start).search(/^##\s/m)
  const end = next < 0 ? note.length : start + next
  let sources: Source[] | undefined
  const kept = note
    .slice(start, end)
    .split('\n')
    .flatMap((line) => {
      const q = /^>\s?(?:\*\*([^*\n]{1,40}?)(?::\*\*|\*\*:)\s*)?(.*)$/.exec(line)
      const said = q?.[2]?.trim()
      if (!q || !said) return [line]
      quotes.total++
      const label = q[1]?.trim()
      const role: SessionMessage['role'] = label === undefined ? 'user' : /^(me|claude)$/i.test(label) ? 'assistant' : 'user'
      sources ??= messages.filter((m) => m.text).map((m) => ({ role: m.role, text: m.text, folded: fold(m.text) }))
      const order = [...sources.filter((s) => s.role === role), ...sources.filter((s) => s.role !== role)]
      const words = verbatim(said, order) ?? verbatim(said.replace(/^["“]([\s\S]*)["”]$/, '$1'), order)
      if (words === undefined) return []
      quotes.found++
      return [label === undefined ? `> ${words}` : `> **${label}:** ${words}`]
    })
  if (!quotes.total) return { text: note, quotes }
  const missing = quotes.total - quotes.found
  const tally = `*${quotes.found} of ${quotes.total} quoted lines found word for word in the conversation${missing ? `; the other${missing > 1 ? 's were' : ' was'} left out` : ''}.*`
  const section = [kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), tally].filter(Boolean).join('\n\n')
  return { text: note.slice(0, start) + '\n' + section + (end < note.length ? '\n\n' + note.slice(end) : ''), quotes }
}

/**
 * Asks a fork of the session for the handoff note, checks its quotes against the conversation (`messages`, else the session's
 * own) and saves it. Undefined when there is nothing to fork or it failed.
 */
async function writeHandoff($: EngineInterface, why: string, messages?: readonly SessionMessage[]): Promise<{ text: string; file: string; paths: Paths; quotes: Quotes } | undefined> {
  $.ui.status('continuity: writing the handoff note…')
  try {
    const reply = await $.model.fork({ prompt: HANDOFF_PROMPT })
    if (!reply.isAnswered) {
      $.ui.log(`continuity: no handoff note (${reply.reason})`)
      return undefined
    }
    if (!reply.text.trim()) return undefined
    const { text, quotes } = checkWords(reply.text.trim(), messages ?? (await $.session.messages().catch(() => [])))
    const p = await paths($)
    const file = join(p.dir, `handoff-${stamp()}.md`)
    const header = `<!-- continuity handoff, ${why}, ${new Date().toISOString()}; transcript: ${p.transcript ?? 'unknown'} -->\n\n`
    await $.fs.write(file, header + text + '\n')
    await $.fs.write(join(p.dir, 'latest.md'), header + text + '\n')
    return { text, file, paths: p, quotes }
  } finally {
    $.ui.status(undefined)
  }
}

/** The note as it comes back into the conversation. */
function noteText(text: string, file: string, transcript: string | undefined): string {
  const lookup = transcript
    ? `The full transcript, including everything from before the compaction, is at ${transcript} (one JSON object per line); search it for the details listed under "Where to look".`
    : 'The full transcript from before the compaction is kept in the session file under ~/.claude/projects/.'
  return [
    '[continuity] My handoff note, written just before this compaction with the whole conversation still in view. The summary above covers the work; this note keeps the reasons, the open threads, the feel of the collaboration and a few of our exchanges word for word.',
    `${lookup} A copy of this note is at ${file}.`,
    '',
    text,
  ].join('\n')
}

/** A short description of the compacted conversation, for the log next to the note (how the engine shaped it). */
function shapeOf(messages: readonly SessionMessage[]) {
  return messages.map((m) => ({ role: m.role, chars: m.text.length, tools: m.toolUses.length, results: m.toolResults?.length ?? 0, handle: m.handle !== undefined }))
}

export const register: Register = (on) => {
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)

    const handoff = await writeHandoff($, `before a ${e.trigger} compaction`, e.messages).catch((err: unknown) => {
      $.ui.log(`continuity: the handoff note failed (${err instanceof Error ? err.message : String(err)})`)
      return undefined
    })

    const instructions = [e.instructions?.trim(), SUMMARY_INSTRUCTIONS].filter(Boolean).join('\n\n')
    const result = await next({ ...e, instructions })
    if (result.skip !== undefined || !handoff) return result

    // The note follows the summary as the next turn: Claude's own message after a user-side summary, else a user-side one.
    const last = result.messages[result.messages.length - 1]
    const role: SessionMessage['role'] = last?.role === 'user' ? 'assistant' : 'user'
    const note: SessionMessage = { role, text: noteText(handoff.text, handoff.file, handoff.paths.transcript), toolUses: [] }
    await $.fs
      .write(join(handoff.paths.dir, `compaction-${stamp()}.json`), JSON.stringify({ trigger: e.trigger, before: e.messages.length, after: shapeOf(result.messages), noteRole: role, quotes: handoff.quotes, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter }, null, 2))
      .catch(() => undefined)
    $.ui.log(`continuity: handoff note kept across the compaction (${handoff.file})`)
    return { ...result, messages: [...result.messages, note] }
  }).catch(($, e, next) => next(e)) // a failure here is the engine's own compaction (replayed if it already ran)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'handoff', description: 'Write a continuity handoff note now, without compacting.' })
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async ($) => {
    const handoff = await writeHandoff($, 'on request')
    const { found, total } = handoff?.quotes ?? { found: 0, total: 0 }
    const words = total ? ` (${found} of ${total} quoted lines found word for word)` : ''
    return handoff ? { text: `Handoff note written: ${handoff.file}${words}` } : { text: 'No handoff note: the session has nothing to fork yet, or the model did not answer.' }
  })
}
