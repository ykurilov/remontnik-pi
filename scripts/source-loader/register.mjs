// Запуск исходников набора в дочернем процессе без сборки: `node --import ./scripts/source-loader/register.mjs file.ts`.
// Нужен тестам, которым важно поведение настоящего процесса (падение, код выхода).
import { register } from 'node:module'

register('./hooks.mjs', import.meta.url)
