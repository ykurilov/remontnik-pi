import { Type } from '@earendil-works/pi-ai'
import type { Context } from '@earendil-works/chord/context'
import { defineTool, hook, ToolTask, type EnvTarget, type JsonObject } from '@earendil-works/pi-durable'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools'
import { ContainerExecutionEnv, type CommandRunner } from '../workbench/index.js'
import { TreatmentDoc, type Diagnosis, type FixSummary, type TreatmentCaseInfo } from './doc.js'

// Инструменты модели-врача. Набор постоянный: одни и те же инструменты в одном порядке для любого случая,
// иначе кэш модели сбрасывается. Файлы и команды — только через окружение верстака (см. createWorkbenchEnvFactory).

export const DOCTOR_TOOL_NAMES = ['read', 'write', 'edit', 'bash', 'case_info', 'finish_diagnosis', 'finish_fix'] as const

export function describeCase(info: TreatmentCaseInfo): string {
  return [
    `Случай ${info.caseId}, приложение ${info.appName}`,
    `Вид сбоя: ${info.kind}`,
    `Где: ${info.where || 'неизвестно'}`,
    `Сообщение: ${info.message}`,
    `Повторов: ${info.events}`,
    'Стек:',
    info.stack || '(нет)',
  ].join('\n')
}

const caseInfo = defineTool({
  name: 'case_info',
  description: 'Сведения о сбое, который ты лечишь: вид, место, сообщение, стек, число повторов.',
  parameters: Type.Object({}),
  replay: 'safe',
  execute: async (_args, api, context) => {
    const state = await api.snapshot(TreatmentDoc, api.conversationId, context)
    if (!state?.case) return { output: [{ type: 'text', text: 'Сведений о случае нет.' }], isError: true }
    return { output: [{ type: 'text', text: describeCase(state.case) }] }
  },
})

const finishDiagnosis = defineTool({
  name: 'finish_diagnosis',
  description: 'Завершить диагноз. found=false, если причина не найдена. evidence — конкретные места кода и наблюдения.',
  parameters: Type.Object({
    found: Type.Boolean({ description: 'Причина найдена' }),
    cause: Type.String({ description: 'Причина сбоя или что удалось понять' }),
    evidence: Type.Array(Type.String(), { description: 'Улики: файлы, строки, вывод команд' }),
    confidence: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
    fixPlan: Type.Optional(Type.String({ description: 'Как исправить, коротко' })),
    causeInPackage: Type.Optional(Type.String({ description: 'Если причина внутри установленного пакета (node_modules), а не в коде приложения, — имя пакета' })),
  }),
  replay: 'safe',
  execute: async (args, api, context) => {
    const diagnosis: Diagnosis = {
      found: args.found,
      cause: args.cause,
      evidence: [...args.evidence],
      confidence: args.confidence,
      ...(args.fixPlan === undefined ? {} : { fixPlan: args.fixPlan }),
      ...(args.causeInPackage === undefined ? {} : { causeInPackage: args.causeInPackage }),
    }
    await api.commit(async (tx) => {
      ;(await tx.doc(TreatmentDoc, api.conversationId)).diagnosis = diagnosis
    }, context)
    return { output: [{ type: 'text', text: 'Диагноз записан.' }], control: { terminate: true } }
  },
})

const finishFix = defineTool({
  name: 'finish_fix',
  description: 'Завершить правку: что изменено и какие тесты добавлены. Коммит сделает врач.',
  parameters: Type.Object({
    summary: Type.String({ description: 'Что изменено, одной-двумя фразами' }),
    testsAdded: Type.Array(Type.String(), { description: 'Файлы добавленных или изменённых тестов' }),
    notes: Type.Optional(Type.String({ description: 'Что стоит знать человеку' })),
  }),
  replay: 'safe',
  execute: async (args, api, context) => {
    const fix: FixSummary = { summary: args.summary, testsAdded: [...args.testsAdded], ...(args.notes === undefined ? {} : { notes: args.notes }) }
    await api.commit(async (tx) => {
      ;(await tx.doc(TreatmentDoc, api.conversationId)).fix = fix
    }, context)
    return { output: [{ type: 'text', text: 'Правка записана.' }], control: { terminate: true } }
  },
})

const DOCTOR_TOOLS = [createReadTool(), createWriteTool(), createEditTool(), createBashTool(), caseInfo, finishDiagnosis, finishFix] as const

export function doctorTools() {
  return DOCTOR_TOOLS
}

export interface BashLimits {
  defaultTimeoutSeconds: number
  maxTimeoutSeconds: number
}

// git как отдельное слово команды: в начале, после разделителя, скобки, подстановки или пути (`/usr/bin/git`).
const GIT_COMMAND = /(^|[\s;&|(`$/])git(?=$|[\s;&|)`])/

/** Аргументы bash, с которыми команда пойдёт в верстак, или отказ. */
export function bashCallPolicy(args: JsonObject, limits: BashLimits): { arguments: JsonObject } | { block: string } {
  const command = typeof args.command === 'string' ? args.command : ''
  if (GIT_COMMAND.test(command)) return { block: 'git в верстаке не нужен: коммит и ветку делает врач после finish_fix.' }
  const asked = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : limits.defaultTimeoutSeconds
  return { arguments: { ...args, timeout: Math.min(asked, limits.maxTimeoutSeconds) } }
}

/** Каждой команде bash — тайм-аут, git — нельзя. */
export const doctorToolGuard = hook(ToolTask, {
  beforeTool: async (call, api, context) => {
    if (call.name !== 'bash') return undefined
    const state = await api.snapshot(TreatmentDoc, api.conversationId, context)
    if (!state?.workbench) return { block: 'верстак не готов' }
    return bashCallPolicy(call.arguments as JsonObject, {
      defaultTimeoutSeconds: state.workbench.bashTimeoutSeconds,
      maxTimeoutSeconds: state.workbench.maxTimeoutSeconds,
    })
  },
})

export interface WorkbenchEnvFactoryOptions {
  runner: CommandRunner
  /** Постоянные переменные команд верстака. */
  env?: Record<string, string>
}

/**
 * `HarnessOptions.env` врача: окружение строится по документу лечения разговора. Нет документа — нет окружения,
 * и встроенные инструменты отвечают ошибкой. git внутри верстака дополнительно отрезан `GIT_DIR`.
 */
export function createWorkbenchEnvFactory(options: WorkbenchEnvFactoryOptions) {
  return async (target: EnvTarget, context: Context): Promise<ExecutionEnv | undefined> => {
    const state = await target.read.snapshot(TreatmentDoc, target.conversationId, context)
    if (!state?.workbench) return undefined
    return new ContainerExecutionEnv({
      root: state.workbench.root,
      runner: options.runner,
      closedPaths: state.workbench.closedPaths,
      defaultTimeoutSeconds: state.workbench.bashTimeoutSeconds,
      maxTimeoutSeconds: state.workbench.maxTimeoutSeconds,
      env: { CI: '1', GIT_DIR: '/nonexistent', ...options.env },
    })
  }
}
