// The polyfill tsyringe checks for as `@simplewebauthn/server` loads. It sits in an ES module of its own because a bundle reaching the app through `import()`, as `kay build --compile` does, runs a module's CommonJS imports after its ES ones.
import 'reflect-metadata'
