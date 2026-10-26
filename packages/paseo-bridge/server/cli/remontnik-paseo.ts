#!/usr/bin/env node
import { runPaseoCommand } from './run-paseo-command.js'

process.exitCode = await runPaseoCommand(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
})
