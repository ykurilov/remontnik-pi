#!/usr/bin/env node
import { runDoctorCommand } from './run-doctor-command.js'

process.exitCode = await runDoctorCommand(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
})
