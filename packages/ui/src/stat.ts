import type { IconSlot } from './defaults'

// How a figure moved since the period before it, shown beside the figure.
export interface StatDelta {
  // The change as the app words it, such as `+12%` or `-3`.
  value: string
  // What it is measured against, such as `vs previous`.
  label?: string | undefined
  // Colours the change; `neutral` keeps the muted text. Whether up is good is the app's to say: `tone="danger"` on a rise in errors.
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' | undefined
  // Picks the arrow; it follows the sign of `value` by default, a `+` up, a `-` down and anything else flat.
  direction?: 'up' | 'down' | 'flat' | undefined
}

const DIRECTION_ICONS = { up: 'trendUp', down: 'trendDown', flat: 'trendFlat' } as const satisfies Record<NonNullable<StatDelta['direction']>, IconSlot>
const SIGN_DIRECTIONS: Record<string, NonNullable<StatDelta['direction']>> = { '+': 'up', '-': 'down', '−': 'down' }

// The arrow of a change, so colour is never its only signal.
export function deltaIcon({ value, direction }: StatDelta): IconSlot {
  return DIRECTION_ICONS[direction ?? SIGN_DIRECTIONS[value.trim().charAt(0)] ?? 'flat']
}
