// The polyfill tsyringe checks for as `@simplewebauthn/server` loads, in an ES module of its own: a bundle loading the app through `import()`, as `kay build --compile` does, runs a module's CommonJS imports after its ES ones, so simplewebauthn's own `import 'reflect-metadata'` comes too late.
import 'reflect-metadata'
