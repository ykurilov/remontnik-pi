#!/usr/bin/env node
import { runBrowserCli } from './index.js'

const code = await runBrowserCli(process.argv.slice(2), {
  env: process.env,
  stdin: process.stdin,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
})
process.exitCode = code
