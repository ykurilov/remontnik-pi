// Как «Пациент» отдаёт свои сбои сторожу: так же подключается любое приложение.
import type { Watch } from '@ykurilov/remontnik-watch'
import type { FinishedConversation } from '../../src/bot/conversations.ts'
import type { PatientErrorReport } from '../../src/server.ts'

export function reportToWatch(watch: Pick<Watch, 'capture'>): (report: PatientErrorReport) => void {
  return (report) => {
    if (report.kind === 'crash') watch.capture(report.error, { kind: 'crash', context: { request: report.where } })
    else if (report.kind === 'model_error') {
      watch.capture(report.error, { kind: 'model_error', where: report.model, context: { model: report.model, provider: report.provider } })
    } else watch.capture(report.error, { kind: 'tool_error', where: report.tool, context: { tool: report.tool } })
  }
}

/** Как «Пациент» отдаёт сторожу законченные разговоры: так же подключается любое приложение. */
export function sendConversationsToWatch(watch: Pick<Watch, 'conversationFinished'>): (conversation: FinishedConversation) => void {
  return (conversation) => watch.conversationFinished(conversation)
}
