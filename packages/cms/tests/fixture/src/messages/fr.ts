import { defineMessages } from 'kay/i18n'

// A few of kayjs-cms's texts worded under `cms.*`; the others keep their English.
export default defineMessages({
  cms: {
    admin: {
      brand: 'Administration',
      content: 'Contenu',
      uploads: 'Fichiers inutilisés',
      newEntry: 'Nouvelle entrée',
      entryCount: { one: '{count} entrée', other: '{count} entrées' },
      search: 'Chercher',
    },
    editor: {
      label: 'Éditeur de contenu',
      title: 'Modifier cette page',
      stop: 'Arrêter de modifier',
      // The only HTML-looking value: a catalog's text is text.
      hide: '<b>Masquer</b> l\'éditeur',
      empty: 'Rien sur cette page ne vient d\'une collection.',
    },
    entry: { loading: 'Chargement…', save: 'Enregistrer', reset: 'Annuler', draft: 'Brouillon' },
    field: { item: 'Élément {n}', removeItem: 'Retirer l\'élément {n}', add: 'Ajouter' },
    file: { upload: 'Téléverser', replace: 'Remplacer', drop: 'ou déposez un fichier ici', pathLabel: 'Chemin', rejected: '{name} est {type}, que les envois ici n\'acceptent pas : {accept}' },
    upload: {
      tooLarge: '{name} pèse {size}, au-delà des {limit} permis par envoi',
      empty: '{name} est vide',
      refused: '{name} est {type}, que les envois ici n\'acceptent pas : {accepted}',
    },
    store: { noCollection: 'Aucune collection {name}', noEntry: 'Aucune entrée {slug} dans {collection}' },
    uploads: {
      nothingDeleted: 'Rien n\'a été supprimé : {reasons}',
      deleteMany: { one: 'Supprimer 1 fichier et ses variantes ?', other: 'Supprimer {count} fichiers et leurs variantes ?' },
      empty: 'Aucun fichier inutilisé',
    },
    table: { title: 'Titre', actions: 'Actions' },
  },
})
