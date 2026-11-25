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

// ── Graphical surfaces (desktop, VS Code, mobile): dark glass band ──────────────────────────

type Tone = ReturnType<typeof tone>

/** Each tone as a gradient (start, end) and the tint of its pill. */
const PALETTE: Record<Tone, { from: string; to: string; text: string; tint: string; edge: string }> = {
  success: { from: '#10b981', to: '#22d3ee', text: '#34d399', tint: 'rgba(16,185,129,0.12)', edge: 'rgba(52,211,153,0.40)' },
  warning: { from: '#f59e0b', to: '#fb923c', text: '#fbbf24', tint: 'rgba(245,158,11,0.12)', edge: 'rgba(251,191,36,0.40)' },
  error: { from: '#f43f5e', to: '#fb7185', text: '#fb7185', tint: 'rgba(244,63,94,0.14)', edge: 'rgba(251,113,133,0.45)' },
}

const GLASS = {
  background: 'rgba(16,21,26,0.82)',
  border: 'rgba(110,231,183,0.20)',
  borderHover: 'rgba(110,231,183,0.38)',
  muted: '#8b949e',
  divider: 'rgba(255,255,255,0.12)',
}

const GAUGE_PX = 160
const GAUGE_H = 14

/** The track and its gradient fill, with a soft glow under the fill. */
function gaugeSvg(p: number, t: Tone, isEmpty: boolean): string {
  const c = PALETTE[t]
  const pad = 4
  const track = GAUGE_PX - pad * 2
  const fill = isEmpty ? 0 : Math.min(track, Math.max(p > 0 ? 6 : 0, Math.round((Math.min(p, 100) / 100) * track)))
  const y = (GAUGE_H - 6) / 2
  const filled =
    fill > 0
      ? `<rect x="${pad}" y="${y}" width="${fill}" height="6" rx="3" fill="url(#ctx-g-${t})" opacity="0.55" filter="url(#ctx-glow-${t})"/>` +
        `<rect x="${pad}" y="${y}" width="${fill}" height="6" rx="3" fill="url(#ctx-g-${t})"/>` +
        `<rect x="${pad + 2}" y="${y + 1}" width="${Math.max(0, fill - 4)}" height="1" rx="0.5" fill="#fff" opacity="0.28"/>`
      : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${GAUGE_PX}" height="${GAUGE_H}" viewBox="0 0 ${GAUGE_PX} ${GAUGE_H}">` +
    `<defs><linearGradient id="ctx-g-${t}" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0" stop-color="${c.from}"/><stop offset="1" stop-color="${c.to}"/></linearGradient>` +
    `<filter id="ctx-glow-${t}" x="-10%" y="-150%" width="120%" height="400%"><feGaussianBlur stdDeviation="2.2"/></filter></defs>` +
    `<rect x="${pad}" y="${y}" width="${track}" height="6" rx="3" fill="rgba(255,255,255,0.07)" stroke="rgba(255,255,255,0.06)" stroke-width="0.75"/>` +
    filled +
    `</svg>`
  )
}

const PILL_H = 22

/**
 * The percentage pill, drawn whole: a bordered Box is much taller than its text on the
 * desktop, so the pill, its lit dot and its figure are one thin drawing.
 */
function percentPill(percent: string, t: Tone): { source: string; width: number } {
  const c = PALETTE[t]
  const width = 30 + percent.length * 8
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${PILL_H}" viewBox="0 0 ${width} ${PILL_H}">` +
    `<defs><filter id="ctx-dot-${t}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.2"/></filter></defs>` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${PILL_H - 1}" rx="${(PILL_H - 1) / 2}" fill="${c.tint}" stroke="${c.edge}"/>` +
    `<circle cx="11" cy="11" r="3.6" fill="${c.text}" opacity="0.55" filter="url(#ctx-dot-${t})"/>` +
    `<circle cx="11" cy="11" r="2.4" fill="${c.text}"/>` +
    `<text x="19" y="15.2" fill="${c.text}" font-family="Segoe UI, system-ui, -apple-system, sans-serif" ` +
    `font-size="12.5" font-weight="600" style="font-variant-numeric: tabular-nums">${percent}</text></svg>`
  return { source, width }
}

/**
 * A line icon: each path carries its own stroke, so nothing depends on a group's
 * inherited attributes surviving the surface's clean-up of the markup.
 */
function lineIcon(size: number, box: number, width: number, color: string, paths: readonly string[]): string {
  const stroke = `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${box} ${box}">` +
    paths.map(d => `<path d="${d}" ${stroke}/>`).join('') +
    `</svg>`
  )
}

const ICON_COLOR = '#c9d1d9'

/** Fold: two arrows meeting on a dashed line, the context squeezed (after Lucide, ISC). */
const COMPACT_ICON = lineIcon(14, 24, 2, ICON_COLOR, [
  'M12 22v-6', 'M12 8V2', 'M4 12H2', 'M10 12H8', 'M16 12h-2', 'M22 12h-2', 'm15 19-3-3-3 3', 'm15 5-3 3-3-3',
])

/** Handshake: the work handed to the next session (after Lucide, ISC). */
const HANDOFF_ICON = lineIcon(15, 24, 2, ICON_COLOR, [
  'm11 17 2 2a1 1 0 1 0 3-3',
  'm14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4',
  'm21 3 1 11h-2',
  'M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3',
  'M3 4h8',
])

const PILL_BORDER = 'rgba(255,255,255,0.14)'
const PILL_BACKGROUND = 'rgba(255,255,255,0.04)'

/** A small stack of coins: the unit of the figures beside it. */
const TOKENS_ICON = lineIcon(14, 16, 1.3, GLASS.muted, [
  'M3 4a5 2 0 1 0 10 0a5 2 0 1 0 -10 0',
  'M3 4v4c0 1.1 2.2 2 5 2s5-.9 5-2V4',
  'M3 8v4c0 1.1 2.2 2 5 2s5-.9 5-2V8',
])

const DIVIDER =
  `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="18" viewBox="0 0 1 18">` +
  `<rect width="1" height="18" fill="${GLASS.divider}"/></svg>`

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
    const percent = g.tokens === null ? '–' : `${p}%`
    const compactLabel = running === 'compact' ? 'Compacting…' : queued ? 'After this turn' : 'Compact'
    const handoffLabel = running === 'handoff' ? 'Sent…' : 'Handoff note'
    const hide = () => update($, isHidden, () => true)

    if (e.surface !== 'terminal') {
      const { Svg } = $.ui.resolve(e)
      const c = PALETTE[t]
      const pill = percentPill(percent, t)
      return (
        <Box
          key="band"
          flexDirection="row"
          alignItems="center"
          gap="sm"
          paddingX="md"
          paddingY="xs"
          backgroundColor={GLASS.background}
          borderStyle="round"
          borderColor={p >= ORANGE ? c.edge : GLASS.border}
          hover={{ borderColor: p >= ORANGE ? c.text : GLASS.borderHover }}
        >
          {/* Percentage pill: lit dot and figure on a tinted ground, one thin drawing. */}
          <Svg source={pill.source} alt={percent} width={pill.width} height={PILL_H} />

          <Svg
            source={gaugeSvg(p, t, g.tokens === null)}
            alt={`Context ${percent} of the ${g.autoCompact ? 'auto-compaction limit' : 'window'}`}
            width={GAUGE_PX}
            height={GAUGE_H}
          />

          <Box flexDirection="row" alignItems="center" gap="xs" flexShrink={0}>
            <Svg source={TOKENS_ICON} alt="Tokens" width={14} height={14} />
            <Text key="figures" color={GLASS.muted} size="caption" tabular>{figures}</Text>
            <Text key="unit" color={GLASS.muted} size="caption">tokens</Text>
          </Box>

          <Box flexGrow={1} />

          <Box flexDirection="row" alignItems="center" gap="sm" flexShrink={0}>
            <Svg source={DIVIDER} alt="Separator" width={1} height={18} />
            {/* Each button is a pill like the percentage: a thin border, a faint ground, an icon
                and a chromeless Button (the desktop takes no drawing inside a Button). */}
            <Box
              key="compact-pill"
              flexDirection="row"
              alignItems="center"
              gap="xs"
              paddingX="sm"
              paddingY={0}
              flexShrink={0}
              backgroundColor={PILL_BACKGROUND}
              borderStyle="round"
              borderColor={urgent || queued ? c.edge : PILL_BORDER}
              hover={{ borderColor: urgent || queued ? c.text : GLASS.borderHover }}
            >
              <Svg source={COMPACT_ICON} alt="Compact icon" width={14} height={14} />
              <Button
                key="compact"
                label={compactLabel}
                plain
                dimColor={running !== null && running !== 'compact'}
                onPress={onCompact}
              />
            </Box>
            <Box
              key="handoff-pill"
              flexDirection="row"
              alignItems="center"
              gap="xs"
              paddingX="sm"
              paddingY={0}
              flexShrink={0}
              backgroundColor={PILL_BACKGROUND}
              borderStyle="round"
              borderColor={PILL_BORDER}
              hover={{ borderColor: GLASS.borderHover }}
            >
              <Svg source={HANDOFF_ICON} alt="Handoff icon" width={15} height={15} />
              <Button
                key="handoff"
                label={handoffLabel}
                plain
                dimColor={running !== null && running !== 'handoff'}
                onPress={onHandoff}
              />
            </Box>
            <Box
              key="hide-pill"
              flexDirection="row"
              alignItems="center"
              paddingX="xs"
              paddingY={0}
              flexShrink={0}
              backgroundColor={PILL_BACKGROUND}
              borderStyle="round"
              borderColor={PILL_BORDER}
              hover={{ borderColor: GLASS.borderHover }}
            >
              <Button key="hide" label="×" plain dimColor onPress={hide} />
            </Box>
          </Box>
        </Box>
      )
    }

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
          <Button key="hide" label="×" plain dimColor onPress={hide} />
        </Box>
      </Box>
    )
  })
}
