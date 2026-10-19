import { defineMessages } from 'kay/i18n'
import mail from '../../../../../mail/src/messages/fr'

// kayjs-mail's French, and a few of kayjs-ui's texts worded under `ui.*` over the French the library ships.
export default defineMessages({
  ...mail,
  ui: {
    pagination: { label: 'Pages', previousLabel: 'Précédent', nextLabel: 'Suivant' },
    // The old key of BarList's `empty` is still read, as the new key of MediaGallery's `emptyLabel` is.
    barList: { emptyLabel: 'Aucune donnée' },
    contactForm: { submitLabel: 'Expédier' },
    // The shipped French says `Confirmer la suppression`: the app's own wording wins key by key.
    confirmDelete: { title: 'Supprimer cet élément ?' },
    mediaGallery: { emptyLabel: 'Aucun média' },
    table: { filterLabel: 'Filtrer', rowCount: { one: '{count} ligne', other: '{count} lignes' } },
  },
})
