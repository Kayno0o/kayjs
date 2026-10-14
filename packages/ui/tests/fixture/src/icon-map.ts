import type { Settings } from '@kaynooo/kayjs-ui'
import { defaults } from '@kaynooo/kayjs-ui'

const { alert, back, chevron, close, delete: remove, globe, info, menu, play, plus, search, spinner, star, success, zoomFit, zoomIn, zoomOut } = defaults.icons

// A map an app wrote before the pause slot was added: it still type-checks, the carousel drawing the default pause icon.
export const written: Settings['icons'] = { alert, back, chevron, close, delete: remove, globe, info, menu, play, plus, search, spinner, star, success, zoomFit, zoomIn, zoomOut }
