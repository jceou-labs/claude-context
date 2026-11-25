import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'context-claude',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function state(on: any, seeds: Record<string, unknown>) {
  const values: Record<string, unknown> = {
    gauge: { tokens: 300_000, window: 1_000_000, limit: 400_000, autoCompact: true },
    isHidden: false,
    busy: null,
    compactQueued: false,
    ...seeds,
  }
  const versions: Record<string, number> = {}
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: values[e.key], version: versions[e.key] ?? 1 } }))
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => {
    values[e.key] = e.value
    versions[e.key] = (versions[e.key] ?? 1) + 1
    return { value: { isSet: true, version: versions[e.key] } }
  })
  on('ui.toast', () => ({ value: undefined }))
  return values
}

// The percentage: a Text on the terminal, the pill drawing's alt on graphical surfaces.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function percentOf(ui: any): Promise<string | undefined> {
  const text = await ui.find({ type: 'Text', text: /^(\d+%|–)$/ })
  if (text) return text.text
  const svgs: { props: Record<string, unknown> }[] = await ui.findAll({ type: 'Svg' })
  return svgs.map(s => String(s.props.alt)).find(a => /^(\d+%|–)$/.test(a))
}

test('the band shows the percentage of the limit, the figures and the buttons on every surface', async ($, on) => {
  state(on, {})
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    expect(await percentOf(ui)).toBe('75%')
    expect((await ui.find({ type: 'Text', text: / \/ / }))?.text).toBe('300k / 400k')
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'handoff' })).toBeTruthy()
    await ui.unmount()
  }
})

// Bug seen at 7 %: the bar wrapped to a second line on the desktop.
test('on the terminal, at a low percentage the bar keeps its full width, split in two clipped pieces', async ($, on) => {
  state(on, { gauge: { tokens: 28_000, window: 1_000_000, limit: 400_000, autoCompact: true } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect((await ui.find({ type: 'Text', text: /^(\d+%|–)$/ }))?.text).toBe('7%')
  const [filled = '', empty = ''] = (await ui.findAll({ type: 'Text', text: /^━+$/ })).map(x => x.text ?? '')
  expect(filled.length).toBe(2)
  expect(filled.length + empty.length).toBe(30)
  await ui.unmount()
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function gaugeSource(ui: any): Promise<string> {
  const svgs: { props: Record<string, unknown> }[] = await ui.findAll({ type: 'Svg' })
  const gauge = svgs.find(s => String(s.props.alt).startsWith('Context '))
  return gauge ? `${String(gauge.props.alt)}\n${String(gauge.props.source)}` : ''
}

test('on graphical surfaces the gauge is a gradient Svg whose fill follows the percentage', async ($, on) => {
  state(on, { gauge: { tokens: 86_000, window: 1_000_000, limit: 367_000, autoCompact: true } })
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    expect(await percentOf(ui)).toBe('23%')
    expect((await ui.find({ type: 'Text', text: / \/ / }))?.text).toBe('86k / 367k')
    expect(await ui.find({ type: 'Text', text: 'tokens' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /━/ })).toBeFalsy()
    const source = await gaugeSource(ui)
    expect(source).toContain('Context 23%')
    expect(source).toContain('#10b981')
    expect(source).toContain('#22d3ee')
    // 23 % of the 152 px track
    expect(source).toContain('width="35"')
    expect((await ui.find({ type: 'Button', key: 'hide' }))?.props.label).toBe('×')
    expect((await ui.find({ type: 'Button', key: 'compact' }))?.props.plain).toBe(true)
    expect((await ui.find({ type: 'Box', key: 'compact-pill' }))?.props.borderStyle).toBe('round')
    expect((await ui.find({ type: 'Box', key: 'handoff-pill' }))?.props.borderStyle).toBe('round')
    expect((await ui.find({ type: 'Box', key: 'hide-pill' }))?.props.borderStyle).toBe('round')
    // Bug seen on the desktop: an Svg with an empty alt was not drawn at all.
    const svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs.length).toBe(7)
    for (const s of svgs) expect(String(s.props.alt).length).toBeGreaterThan(0)
    await ui.unmount()
  }
})

test('past 90 % the gauge turns red', async ($, on) => {
  state(on, { gauge: { tokens: 380_000, window: 1_000_000, limit: 400_000, autoCompact: true } })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  const source = await gaugeSource(ui)
  expect(source).toContain('Context 95%')
  expect(source).toContain('#f43f5e')
  // The buttons stay neutral: only the gauge, its pill and the band's border take the color.
  const compact = (await ui.find({ type: 'Box', key: 'compact-pill' }))?.props.borderColor
  expect(compact).toBe((await ui.find({ type: 'Box', key: 'handoff-pill' }))?.props.borderColor)
  await ui.unmount()
})

test('with no reading yet the band shows a dash, not a stale percentage', async ($, on) => {
  state(on, { gauge: { tokens: null, window: 1_000_000, limit: 400_000, autoCompact: true } })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
    expect(await percentOf(ui)).toBe('–')
  expect((await ui.find({ type: 'Text', text: / \/ / }))?.text).toBe('– / 400k')
  await ui.unmount()
})

test('with auto-compaction off the bar runs to the whole window', async ($, on) => {
  state(on, { gauge: { tokens: 500_000, window: 1_000_000, limit: 1_000_000, autoCompact: false } })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
    expect(await percentOf(ui)).toBe('50%')
  expect((await ui.find({ type: 'Text', text: / \/ / }))?.text).toBe('500k / 1M')
  await ui.unmount()
})

// Bug seen: after /compact the gauge kept showing the old 50 %.
test('a compaction resets the gauge to the size after it', async ($, on) => {
  const values = state(on, {})
  on('session.compact', (_: unknown, e: { messages: readonly unknown[] }) => ({ messages: e.messages, tokensBefore: 300_000, tokensAfter: 27_000 }) as never)
  const summary = { role: 'user', text: 'Summary of the conversation', toolUses: [] }
  await $.session.compact({ trigger: 'manual', messages: [summary] } as never)
  expect((values.gauge as { tokens: number }).tokens).toBe(27_000)
})

test('Compact pressed between turns compacts right away', async ($, on) => {
  state(on, {})
  let compactions = 0
  on('session.compact', () => {
    compactions += 1
    return { skip: 'test' }
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isWorking: false } } as never)
  await ui.press({ key: 'compact' })
  expect(compactions).toBe(1)
  await ui.unmount()
})

test('Compact pressed during a turn is queued for the end of the turn', async ($, on) => {
  const values = state(on, {})
  let compactions = 0
  on('session.compact', () => {
    compactions += 1
    return { skip: 'test' }
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, isWorking: true } } as never)
  await ui.press({ key: 'compact' })
  expect(compactions).toBe(0)
  expect(values.compactQueued).toBe(true)
  await ui.unmount()
})

test('Handoff note sends the request as a prompt', async ($, on) => {
  state(on, {})
  const sent: string[] = []
  on('prompt.submit', (_: unknown, e: { text: string }) => {
    sent.push(e.text)
    return { text: e.text } as never
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  await ui.press({ key: 'handoff' })
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('handoff note')
  expect(sent[0]).not.toContain('session-handoff')
  await ui.unmount()
})

test('on graphical surfaces the colors hold in light and dark mode', async ($, on) => {
  state(on, {})
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as never)
  // The ground is a drawing with a rule per mode: pale in light, the dark veil in dark.
  const ground = (await ui.findAll({ type: 'Svg' })).find(x => x.props.alt === 'Band background')
  expect(String(ground?.props.source)).toContain('prefers-color-scheme: light')
  expect(String(ground?.props.source)).toContain('rgba(255,255,255,0.72)')
  expect(String(ground?.props.source)).toContain('rgba(4,12,16,0.30)')
  expect((await ui.find({ type: 'Text', text: / \/ / }))?.props.dimColor).toBe(true)
  const svgs: { props: Record<string, unknown> }[] = await ui.findAll({ type: 'Svg' })
  const pill = svgs.find(s => s.props.alt === '75%')
  expect(String(pill?.props.source)).toContain('prefers-color-scheme: light')
  const icon = svgs.find(s => s.props.alt === 'Compact icon')
  expect(String(icon?.props.source)).toContain('prefers-color-scheme: dark')
  await ui.unmount()
})
