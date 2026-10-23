import { defineMessages } from 'kay/i18n'
import mail from '../../../../../mail/src/messages/fr'

// kayjs-mail's French, and a few of kayjs-ui's texts worded under `ui.*` over the French the library ships.
export default defineMessages({
  ...mail,
  ui: {
    pagination: { label: 'Pages', previous: 'Précédent', next: 'Suivant' },
    // BarList's pre-1.72 `emptyLabel` is still read, as MediaGallery's `empty` is; the config allows the deprecation report.
    barList: { emptyLabel: 'Aucune donnée' },
    contactForm: { submit: 'Expédier' },
    // The shipped French says `Confirmer la suppression`: the app's own wording wins key by key.
    confirmDelete: { title: 'Supprimer cet élément ?' },
    mediaGallery: { empty: 'Aucun média' },
    table: { filter: 'Filtrer', rowCount: { one: '{count} ligne', other: '{count} lignes' } },
  },
})
