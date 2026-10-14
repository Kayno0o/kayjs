import type { IconProps } from 'kay/icons'
import type { AddedSlot } from './defaults'
import pause from '~icons/tabler/player-pause'

// The default of each slot added since apps first wrote icon maps of their own, drawn when a map leaves it out.
export const addedIcons: Record<AddedSlot, IconProps> = { pause }
