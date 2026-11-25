export type Gauge = {
  /** Input tokens of the last reply; null until the next reply after a compaction. */
  tokens: number | null
  /** The model's context window. */
  window: number
  /** Where the bar ends: the auto-compaction threshold, or the window when auto-compaction is off. */
  limit: number
  /** Whether `limit` is the auto-compaction threshold. */
  autoCompact: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'context-claude': {
      gauge: Gauge | null
      isHidden: boolean
      busy: string | null
      compactQueued: boolean
    }
  }
}
