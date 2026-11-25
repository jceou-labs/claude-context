import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

import type { Gauge } from '../types'

const gauge = atom({ plugin: 'context-claude', key: 'gauge' } as const, null)
const isHidden = atom({ plugin: 'context-claude', key: 'isHidden' } as const, false)
// Button action still running: the other button is dimmed meanwhile.
const busy = atom({ plugin: 'context-claude', key: 'busy' } as const, null)
// Compact pressed during a turn: compaction is refused while a turn runs, so it starts when the turn ends.
const compactQueued = atom({ plugin: 'context-claude', key: 'compactQueued' } as const, false)

const ORANGE = 70
const RED = 90
const BAR_WIDTH = 30

const HANDOFF_PROMPT =
  'Write a handoff note so this work can continue in a new session: the goal, the current state ' +
  '(verified, not from memory), decisions made, files touched, remaining tasks, and the first next step. ' +
  'Save it to a file and also give me the text ready to paste.'

function reason(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err)
}

/**
 * In the desktop app and other SDK sessions, `$.session.compact()` is refused: compaction
 * goes through the /compact command there, which itself waits for the running turn.
 */
function isHeadless(err: unknown): boolean {
  return /headless|SDK/i.test(reason(err))
}

async function compactByCommand($: EngineInterface): Promise<void> {
  try {
    await $.command.run({ command: 'compact' })
  } catch {
    await $.prompt.submit({ text: '/compact', asUser: true })
  }
}

/** Starts a compaction; retries for a few seconds while a turn is still finishing. */
async function compact($: EngineInterface, attempts = 1): Promise<void> {
  await update($, busy, () => 'compact')
  try {
    for (let i = 1; ; i++) {
      try {
        const r = await $.session.compact()
        if ('skip' in r && r.skip) $.ui.toast(`Compaction skipped: ${r.skip}`)
        return
      } catch (err) {
        if (isHeadless(err)) {
          try {
            await compactByCommand($)
          } catch (err2) {
            $.ui.toast(`Couldn't compact: ${reason(err2)}`)
          }
          return
        }
        if (i >= attempts) {
          $.ui.toast(`Couldn't compact: ${reason(err)}`)
          return
        }
        await $.clock.sleep(1000)
      }
    }
  } finally {
    await update($, busy, () => null)
  }
}

type Limit = { limit: number; autoCompact: boolean }
// The limit only changes with the model or the settings: computed once per window size.
const limitCache = new Map<number, Limit>()

/**
 * Where the bar ends: the token count at which auto-compaction runs, as Claude Code reports it.
 * Without that figure, the `autoCompactWindow` setting, else the whole window.
 */
async function limitFor($: EngineInterface, window: number): Promise<Limit> {
  const cached = limitCache.get(window)
  if (cached) return cached
  let result: Limit | undefined
  try {
    const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    if (b) {
      result =
        b.isAutoCompactEnabled && b.autoCompactThreshold
          ? { limit: b.autoCompactThreshold, autoCompact: true }
          : { limit: b.rawMaxTokens || window, autoCompact: false }
    }
  } catch {
    // No breakdown in this session: fall back to the setting.
  }
  if (!result) {
    try {
      const v = await $.settings.read({ key: 'autoCompactWindow' })
      if (typeof v === 'number' && v > 0 && v < window) result = { limit: v, autoCompact: true }
    } catch {
      // Unreadable setting: keep the whole window.
    }
  }
  result ??= { limit: window, autoCompact: false }
  limitCache.set(window, result)
  return result
}

async function measure($: EngineInterface, context: SessionContextUsage): Promise<void> {
  const { limit, autoCompact } = await limitFor($, context.window)
  const g: Gauge = { tokens: context.tokens ?? null, window: context.window, limit, autoCompact }
  await update($, gauge, () => g)
}

function short(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function tone(p: number): 'success' | 'warning' | 'error' {
  if (p >= RED) return 'error'
  if (p >= ORANGE) return 'warning'
  return 'success'
}

/** A thin line from 0 to the limit: its right end is the limit. */
function bar(p: number): { filled: string; empty: string } {
  const n = Math.min(BAR_WIDTH, Math.max(p > 0 ? 1 : 0, Math.round((p / 100) * BAR_WIDTH)))
  return { filled: '━'.repeat(n), empty: '━'.repeat(BAR_WIDTH - n) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      const u = await $.session.usage()
      await measure($, u.context)
    } catch {
      // No reading yet: the band waits for the first one.
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) await measure($, e.context)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && (await read($, compactQueued))) {
      await update($, compactQueued, () => false)
      // Not awaited: the turn must end first for the compaction to be accepted.
      void compact($, 10)
    }
    return result
  })

  // After a compaction there is no context reading until the next reply:
  // without this hook the gauge would keep the old percentage.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.trigger === 'precompute' || e.agentId || ('skip' in r && r.skip)) return r
    if (!('messages' in r) || !r.messages) return r
    const g = await read($, gauge)
    if (g) await update($, gauge, () => ({ ...g, tokens: r.tokensAfter ?? null }))
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const g = await read($, gauge)
    if (e.props.hasSurvey || g === null || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const running = await read($, busy)
    const queued = await read($, compactQueued)
    const tokens = g.tokens ?? 0
    const p = Math.round((tokens / g.limit) * 100)
    const t = tone(p)
    const b = bar(p)
    const terminal = e.surface === 'terminal'
    // Under 50 % the buttons stay quiet; from 70 % Compact becomes the main action.
    const quiet = p < 50
    const urgent = p >= ORANGE

    const onCompact = async () => {
      if ((await read($, busy)) !== null) return
      if (await read($, compactQueued)) {
        await update($, compactQueued, () => false)
        $.ui.toast('Queued compaction canceled')
        return
      }
      if (e.props.isWorking) {
        await update($, compactQueued, () => true)
        $.ui.toast('Compaction queued: it starts when this turn ends')
        return
      }
      // Not awaited: a compaction takes longer than the 10 s a press may run.
      void compact($)
    }

    const onHandoff = async () => {
      if ((await read($, busy)) !== null) return
      await update($, busy, () => 'handoff')
      try {
        await $.prompt.submit({ text: HANDOFF_PROMPT, asUser: true })
      } catch (err) {
        $.ui.toast(`Couldn't send the handoff request: ${reason(err)}`)
      } finally {
        await update($, busy, () => null)
      }
    }

    const figures = `${g.tokens === null ? '–' : short(tokens)} / ${short(g.limit)}`

    return (
      <Box
        flexDirection="row"
        alignItems="center"
        gap="md"
        paddingX={terminal ? 1 : 'sm'}
        borderStyle={terminal ? 'round' : undefined}
        borderColor={terminal ? (p >= ORANGE ? t : 'subtle') : undefined}
      >
        <Box minWidth={5}>
          <Text key="percent" color={t} weight="semibold" bold tabular>
            {g.tokens === null ? '–' : `${p}%`}
          </Text>
        </Box>

        {/* On the desktop the "━" glyph is a little wider than a cell: what overflows is clipped
            instead of wrapping to a second line. */}
        <Box flexDirection="row" width={BAR_WIDTH} overflow="hidden">
          <Text key="filled" color={t} mono wrap="clip">{b.filled}</Text>
          <Text key="empty" color="subtle" mono wrap="clip">{b.empty}</Text>
        </Box>

        <Text key="figures" dimColor size="caption" tabular>{figures}</Text>

        <Box flexGrow={1} />

        <Box flexDirection="row" alignItems="center" gap="sm">
          <Button
            key="compact"
            label={running === 'compact' ? 'Compacting…' : queued ? 'After this turn' : 'Compact'}
            variant={urgent || queued ? 'primary' : 'secondary'}
            dimColor={!queued && (quiet || (running !== null && running !== 'compact'))}
            onPress={onCompact}
          />
          <Button
            key="handoff"
            label={running === 'handoff' ? 'Sent…' : 'Handoff note'}
            variant="secondary"
            dimColor={quiet || (running !== null && running !== 'handoff')}
            onPress={onHandoff}
          />
          <Button key="hide" label="×" plain dimColor onPress={() => update($, isHidden, () => true)} />
        </Box>
      </Box>
    )
  })
}
