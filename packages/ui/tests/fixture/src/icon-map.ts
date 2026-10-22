import type { UiSettings } from '@kaynooo/kayjs-ui'
import { uiDefaults } from '@kaynooo/kayjs-ui'

const { alert, back, chevron, close, delete: remove, globe, info, menu, play, plus, search, spinner, star, success, zoomFit, zoomIn, zoomOut } = uiDefaults.icons

// A map an app wrote before the pause slot was added: it still type-checks, the carousel drawing the default pause icon.
export const written: UiSettings['icons'] = { alert, back, chevron, close, delete: remove, globe, info, menu, play, plus, search, spinner, star, success, zoomFit, zoomIn, zoomOut }
