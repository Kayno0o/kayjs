import type { PageProps } from './app'
import { hydrate } from 'solid-js/web'
import { App } from './app'

const props = JSON.parse(document.getElementById('page-data')!.textContent!) as PageProps

hydrate(() => <App {...props} />, document.body)
