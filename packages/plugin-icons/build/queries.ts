// Queries people type into an icon picker, scored by the bench beside the learned tag cases: the icons that answer each one, and for some the icons that must not come first (an antonym, a modifier winning over the noun).
// A query counts for a set only when the set holds one of its answers.

export interface Query {
  query: string
  /** Names that answer the query, in either set. */
  answers: string[]
  /** Names that must not be the first result. */
  never?: string[]
}

export const QUERIES: Query[] = [
  { query: 'add user', answers: ['user-plus'], never: ['user', 'user-x'] },
  { query: 'delete file', answers: ['file-x', 'file-minus'] },
  { query: 'remove user', answers: ['user-minus', 'user-x'], never: ['user', 'user-plus'] },
  { query: 'sign out', answers: ['logout', 'logout-2', 'door-exit', 'log-out'] },
  { query: 'log in', answers: ['login', 'log-in'] },
  { query: 'hide password', answers: ['eye-off', 'eye-closed'], never: ['eye', 'trash-off'] },
  { query: 'show password', answers: ['eye'], never: ['eye-off', 'eye-closed'] },
  { query: 'dark mode', answers: ['moon'], never: ['sun'] },
  { query: 'light mode', answers: ['sun'], never: ['moon'] },
  { query: 'left arrow', answers: ['arrow-left'] },
  { query: 'close', answers: ['x', 'circle-x'], never: ['lock-open', 'door-open'] },
  { query: 'cancel', answers: ['x', 'circle-x'] },
  { query: 'dismiss', answers: ['x', 'circle-x'] },
  { query: 'trash can', answers: ['trash', 'trash-2'] },
  { query: 'garbage', answers: ['trash', 'trash-2'] },
  { query: 'check mark', answers: ['check'] },
  { query: 'magnifying glass', answers: ['search', 'zoom'] },
  { query: 'upload file', answers: ['file-upload', 'file-up', 'upload'] },
  { query: 'notifications', answers: ['bell'] },
  { query: 'home page', answers: ['home', 'house'] },
  { query: 'edit text', answers: ['pencil', 'edit', 'pen'] },
  { query: 'save', answers: ['device-floppy', 'save'] },
  { query: 'reload', answers: ['refresh', 'refresh-cw', 'rotate-cw'] },
  { query: 'unlock', answers: ['lock-open', 'lock-open-2'], never: ['lock'] },
  { query: 'warning', answers: ['alert-triangle', 'triangle-alert'] },
  { query: 'more options', answers: ['dots', 'dots-vertical', 'ellipsis', 'ellipsis-vertical'] },
  { query: 'next track', answers: ['player-track-next', 'skip-forward'], never: ['player-track-prev', 'skip-back'] },
  { query: 'previous', answers: ['player-track-prev', 'skip-back', 'chevron-left', 'arrow-left'], never: ['player-track-next', 'skip-forward', 'chevron-right'] },
  { query: 'profile', answers: ['user', 'user-circle', 'circle-user'] },
  { query: 'settings', answers: ['settings', 'cog'] },
  { query: 'mute', answers: ['volume-x', 'volume-3'], never: ['volume', 'volume-2'] },
  { query: 'location', answers: ['map-pin'] },
  { query: 'favorite', answers: ['heart', 'star'] },
  { query: 'filter list', answers: ['filter', 'funnel'] },
  { query: 'no internet', answers: ['wifi-off'], never: ['wifi'] },
]
