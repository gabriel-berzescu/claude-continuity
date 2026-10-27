import { expect, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

// Nothing sits beneath the plugin in a test: these hooks stand for the engine. A call on `$` is answered `{ value }`, an event
// by its own result.

const NOTE = '## Where we are\nPlanning a picnic.\n\n## Decisions and why\n- The lake: the park is being reseeded.'
const SUMMARY: SessionMessage = { role: 'user', text: 'This session is being continued... (summary)', toolUses: [] }
const CHAT: SessionMessage[] = [
  { role: 'user', text: 'Plan a picnic: the lake, not the park (it is being reseeded).', toolUses: [] },
  { role: 'assistant', text: 'The lake it is.', toolUses: [] },
]

// (the engine hands hooks native paths: compare them with forward slashes)
const slashes = (p: string) => p.replace(/\\/g, '/')

function engine(on: On, fork: 'answers' | 'nothing-to-fork', note = NOTE) {
  const writes: { path: string; text: string }[] = []
  const compactions: { instructions?: string }[] = []
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: 'C:\\work\\demo' }))
  on('session.root', () => ({ value: 'C:\\work\\demo' }))
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\T' : undefined }))
  on('fs.exists', (_, e) => ({ value: slashes(e.path).endsWith('/.claude/projects/C--work-demo/sess-1.jsonl') }))
  on('fs.list', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.write', (_, e) => {
    writes.push(e)
    return { value: undefined }
  })
  on('model.fork', () => ({
    value:
      fork === 'answers'
        ? { isAnswered: true, text: note, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
        : { isAnswered: false, reason: 'nothing-to-fork' },
  }))
  on('session.compact', (_, e) => {
    compactions.push({ instructions: e.instructions })
    return { messages: [SUMMARY] }
  })
  on('session.messages', () => ({ value: CHAT }))
  return { writes, compactions }
}

// A note whose quotes are right but for case and curly quotes, trimmed with "…", or made up.
const WORDS_NOTE = `## Where we are
Planning a picnic.

## In our own words
> **Sam:** “Plan a picnic: the lake, not the park”
> **Me:** the lake it is.

> **Sam:** ok lets go with sandwiches … and lemonade :)
> **Me:** Sandwiches are a fine choice!

## Where to look
- "reseeded"`

const WORDS_CHAT: SessionMessage[] = [...CHAT, { role: 'user', text: 'ok lets go with sandwiches... and lemonade :)', toolUses: [] }, { role: 'assistant', text: 'Sandwiches and lemonade, done.', toolUses: [] }]

test('the quoted exchanges are checked against the conversation: kept in its own words, or left out', async ($, on) => {
  engine(on, 'answers', WORDS_NOTE)

  const result = await $.session.compact({ trigger: 'auto', messages: WORDS_CHAT })

  const note = result.messages?.[1]?.text ?? ''
  expect(note).toContain('## In our own words\n> **Sam:** Plan a picnic: the lake, not the park\n> **Me:** The lake it is.\n\n> **Sam:** ok lets go with sandwiches... and lemonade :)\n\n*3 of 4 quoted lines found word for word in the conversation; the other was left out.*\n\n## Where to look\n- "reseeded"')
  expect(note).not.toContain('fine choice')
})

test('/handoff checks the quotes against the session’s own messages', async ($, on) => {
  const { writes } = engine(on, 'answers', WORDS_NOTE)

  const { text } = await $.command.run({ command: 'handoff', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

  expect(text).toContain('Handoff note written:')
  expect(text).toContain('(2 of 4 quoted lines found word for word)')
  const latest = writes.find((w) => slashes(w.path).endsWith('/latest.md'))?.text ?? ''
  expect(latest).toContain('> **Me:** The lake it is.')
  expect(latest).not.toContain('sandwiches')
})

test('a compaction keeps the handoff note right after the summary, as Claude speaking', async ($, on) => {
  const { writes, compactions } = engine(on, 'answers')

  const result = await $.session.compact({ trigger: 'manual', instructions: 'focus on the plan', messages: CHAT })

  expect(result.skip).toBe(undefined)
  const messages = result.messages ?? []
  expect(messages.length).toBe(2)
  expect(messages[0]?.text).toBe(SUMMARY.text)
  const note = messages[1]
  expect(note?.role).toBe('assistant')
  expect(note?.text).toContain('[continuity]')
  expect(note?.text).toContain(NOTE)
  expect(note?.text).toContain('C:\\Users\\T\\.claude\\projects\\C--work-demo\\sess-1.jsonl')

  // the summariser got the person's words first, then the standing instructions
  expect(compactions.length).toBe(1)
  expect(compactions[0]?.instructions?.startsWith('focus on the plan\n\n')).toBe(true)
  expect(compactions[0]?.instructions).toContain('decisions together with their reasons')

  // the note is saved (a dated copy and latest.md), with the shape of the compaction beside it
  const paths = writes.map((w) => slashes(w.path))
  expect(paths.some((p) => /continuity\/sess-1\/handoff-.*\.md$/.test(p))).toBe(true)
  expect(paths).toContain('C:/Users/T/.claude/continuity/sess-1/latest.md')
  expect(paths.some((p) => /compaction-.*\.json$/.test(p))).toBe(true)
})

test('with nothing to fork, the compaction is the engine’s own, still with the standing instructions', async ($, on) => {
  const { writes, compactions } = engine(on, 'nothing-to-fork')

  const result = await $.session.compact({ trigger: 'auto', messages: CHAT })

  expect(result.messages?.length).toBe(1)
  expect(compactions[0]?.instructions).toContain('open thread')
  expect(writes.length).toBe(0)
})

test('a subagent’s own compaction passes through untouched', async ($, on) => {
  const { writes, compactions } = engine(on, 'answers')

  const result = await $.session.compact({ trigger: 'auto', agentId: 'agent-7', messages: CHAT })

  expect(result.messages?.length).toBe(1)
  expect(compactions[0]?.instructions).toBe(undefined)
  expect(writes.length).toBe(0)
})
