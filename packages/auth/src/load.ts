// Each feature's module, read when a request first reaches it: an app that leaves a feature off, or never calls it, never loads it.
export const load = {
  account: async () => import('./account'),
  admin: async () => import('./admin'),
  bearer: async () => import('./bearer'),
  email: async () => import('./email'),
  erase: async () => import('./erase'),
  profile: async () => import('./profile'),
  exports: async () => import('./export'),
  flow: async () => import('./oauth/flow'),
  grants: async () => import('./authorize/grants'),
  organizations: async () => import('./organizations'),
  passkeys: async () => import('./passkeys'),
  password: async () => import('./password'),
  request: async () => import('./authorize/request'),
  twoFactor: async () => import('./twoFactor'),
}
