import { underKayDev } from 'kay/library'
import { api, editRequested } from 'kay/server'
import { wording } from 'kay/words'
import { settings } from '../settings'

// The texts of the dev tool's tab in the visitor's language, which the browser module cannot look up itself. `{failure}` is filled in there.
function devWords(): Record<string, string> {
  return {
    editing: wording('cms.dev.editing', 'You are in edit mode on this site.'),
    notEditing: wording('cms.dev.notEditing', 'You are not in edit mode.'),
    edit: wording('cms.page.edit', 'Edit this page'),
    leave: wording('cms.dev.leave', 'Leave edit mode'),
    guard: wording('cms.dev.guard', 'The screens\' guard decides whether you may.'),
    screens: wording('cms.dev.screens', 'Open the screens'),
    readFailure: wording('cms.dev.readFailure', 'Could not read the edit mode: {failure}', { failure: '{failure}' }),
    leaveFailure: wording('cms.dev.leaveFailure', 'Could not leave edit mode: {failure}', { failure: '{failure}' }),
    unavailable: wording('cms.dev.unavailable', 'kayjs-cms answers here under `kay dev` alone.'),
    answered: wording('cms.dev.answered', 'the server answered {status}', { status: '{status}' }),
  }
}

// What the dev tool's CMS tab reads under `kay dev`, in the visitor's language as every api route runs.
export default api()
  .get('/', ({ request, set, status }) => {
    if (!underKayDev())
      return status(404)

    set.headers['cache-control'] = 'no-store'

    return { editing: editRequested(request), prefix: settings().prefix, exit: '/api/cms/preview/exit', words: devWords() }
  })
