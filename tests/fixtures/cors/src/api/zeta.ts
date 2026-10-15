import { api } from 'kay/server'

// Sorted after the modules with a cors rule, which must not reach its answers.
export default api().get('/', () => new Response('zeta', { headers: { 'access-control-allow-origin': 'https://own.example' } }))
