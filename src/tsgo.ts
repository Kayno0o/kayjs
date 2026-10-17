#!/usr/bin/env bun
// The `tsgo` command, for scripts that run the type checker bare: it runs the native compiler kay checks with.
import process from 'node:process'
import { nativeExe } from './compiler/native-typescript'

const child = Bun.spawn([nativeExe(), ...process.argv.slice(2)], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })

process.exitCode = await child.exited
