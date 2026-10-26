export { CASE_LINKED_EVENTS_LIMIT, CLOSED_CASE_STATES, createCaseBook, type Case, type CaseBook, type CaseState } from './case-book/index.js'
export { INTAKE_MAX_BODY_BYTES, INTAKE_MAX_EVENTS, createIntakeHandler, startIntakeServer, type IntakeServer } from './intake/index.js'
export { createReportsFeedHandler, type ReportsFeedAccess } from './intake/reports-feed.js'
export { createMemoryRecordStore, type RecordStore, type RecordTransaction } from './records/index.js'
export { REPORT_FULL_LIMIT, REPORT_RETRY_DELAYS_MS, createReports, type Report, type ReportType, type Reports } from './reports/index.js'
export { startDoctorService, type DoctorService, type DoctorServiceOptions } from './service/index.js'
export { doctorStartPlan, startDoctorFromEnv, type DoctorEnv } from './service/start.js'
export { createGitGuard, slugify, treatmentBranch, type GitGuard, type GitGuardOptions } from './git-guard/index.js'
export { type DoctorTreatmentOptions } from './service/index.js'
export {
  DOCTOR_TOOL_NAMES,
  TreatmentDoc,
  createRecordEvalBaseCache,
  createTreatment,
  createWorkbenchEnvFactory,
  type Treatment,
  type TreatmentDeps,
  type TreatmentOutcome,
  type TreatmentResult,
} from './treatment/index.js'
export { assertInternalDockerNetwork, createDockerRunner, createLocalRunner, type CommandRunner } from './workbench/index.js'
export { startEgressProxy, type EgressProxy, type EgressProxyOptions } from './egress-proxy/index.js'
export { createEvalProxy, type EvalProxy, type EvalProxyOptions } from './eval-proxy/index.js'
export { runDoctorCommand, type DoctorCommandIo } from './cli/run-doctor-command.js'
