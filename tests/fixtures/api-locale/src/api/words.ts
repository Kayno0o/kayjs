import { t as message } from 'kay/i18n'
import { api, eventStream } from 'kay/server'
import { wording } from 'kay/words'

const pause = async (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const read = () => ({ word: wording('words.refused', 'Refused'), t: message('greeting') })

export default api()
  .onError(({ code, error }) => code === 'UNKNOWN' && error.message === 'boom' ? { custom: wording('words.refused', 'Refused') } : undefined)
  .get('/', () => read())
  .get('/plain', () => ({ word: wording('words.refused', 'Refused') }))
  // The locale survives an await, and two requests overlapping in time each keep their own.
  .get('/late', async ({ query }) => {
    await pause(Number(query.ms ?? 1))

    return read()
  })
  .get('/stream', () => eventStream((async function* () {
    await pause(1)
    yield read()
  })()))
  .get('/generator', async function* () {
    await pause(1)
    yield read()
  })
  .get('/own-error', () => {
    throw new Error('own')
  }, { error: () => ({ own: wording('words.refused', 'Refused') }) } as never)
  .get('/boom', () => {
    throw new Error('boom')
  })
