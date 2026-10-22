import { defineMessages } from 'kay/i18n'

// The French of every `ai.*` key the chat looks up, which a site on a French page gets with no setup and overrides key by key in its own `src/messages/fr.ts`.
export default defineMessages({
  ai: {
    chat: {
      arguments: 'Arguments',
      close: 'Fermer le chat',
      collapse: 'Réduire le chat',
      disclosure: 'Vous discutez avec une IA. Vos messages sont envoyés à son fournisseur pour y répondre.',
      done: 'Terminé',
      error: 'La réponse a échoué.',
      expand: 'Agrandir le chat',
      failed: 'Échec',
      greeting: 'Comment puis-je vous aider ?',
      label: 'Chat',
      new: 'Nouvelle conversation',
      open: 'Ouvrir le chat',
      placeholder: 'Écrivez un message…',
      result: 'Résultat',
      retry: 'Réessayer',
      running: 'En cours',
      send: 'Envoyer',
      stop: 'Arrêter',
      stopped: 'Arrêtée',
      table: 'Tableau',
      thinking: 'Réflexion…',
    },
  },
})
