import { defineMessages } from 'kay/i18n'
import mail from '../../../../../mail/src/messages/fr'

// kayjs-mail's French, and a few of kayjs-ui's texts worded under `ui.*`; the others keep their English.
export default defineMessages({
  ...mail,
  ui: {
    pagination: { label: 'Pages', previousLabel: 'Précédent', nextLabel: 'Suivant' },
    table: { filterLabel: 'Filtrer', rowCount: { one: '{count} ligne', other: '{count} lignes' } },
  },
})
