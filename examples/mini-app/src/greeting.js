/** Приветствие. При EXAMPLE_BUG=crash «память посетителей» через мгновение роняет процесс: заложенный сбой для проверки. */
export function greet(name, { bug = process.env.EXAMPLE_BUG, crashProcess = rethrow } = {}) {
  if (bug === 'crash') rememberVisit(name, crashProcess)
  return `Здравствуйте, ${name}!`
}

function rethrow(error) {
  throw error
}

function rememberVisit(name, crashProcess) {
  setImmediate(() => {
    try {
      throw new Error(`visit store is closed (EXAMPLE_BUG=crash), name length ${name.length}`)
    } catch (error) {
      crashProcess(error)
    }
  })
}
