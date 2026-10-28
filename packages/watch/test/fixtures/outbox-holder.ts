// Отдельный живой процесс, который держит очередь сторожа открытой, пока его не остановят.
// Печатает путь своего файла и снимок папки после открытия.
import { readdirSync } from 'node:fs'
import { openOutbox } from '@ykurilov/remontnik-watch'

const dir = process.env.OUTBOX_DIR ?? ''
const outbox = openOutbox({ dir, processName: process.env.OUTBOX_PROCESS ?? 'web' })
console.log(JSON.stringify({ file: outbox.file, files: readdirSync(dir).sort() }))
setInterval(() => {}, 1_000)
process.on('SIGTERM', () => {
  outbox.close()
  process.exit(0)
})
