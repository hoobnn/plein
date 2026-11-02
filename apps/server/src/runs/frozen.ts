import { createHash } from 'node:crypto'
import { stableStringify } from '@plein/canonical'
import { isGenerationOrigin, type GenerationOrigin } from '@plein/doc'
import type { PortValue } from '@plein/plugin-sdk'
import type { DeliveryOrigins } from '../executors/delivery'

import type { CallRecord } from '../plugins/provider-protocol'
import type { JobRow } from './store'

/** 提交时冻结的参数与输入值（jobs.frozen） */
export interface Frozen {
  nodeVersion?: number
  /** Persisted before first execution; never reconstructed from a restored job's local aliases. */
  executionOrigin?: Pick<GenerationOrigin, 'canvasId' | 'nodeId' | 'runId'>
  /** Original candidates are durably bound before publication, independently of local result aliases. */
  outputEvidence?: OutputEvidence
  params: Record<string, unknown> | undefined
  inputs: Record<string, PortValue[]>
  inputHash?: string
  deliveryOrigins?: DeliveryOrigins
}

export type OutputCall = {
  inputFingerprint: string
} & (
  | { kind: 'provider'; calls: Array<{ key: string; attemptId: string; requestId: string }> }
  | { kind: 'local'; execution: NonNullable<Frozen['executionOrigin']> }
)

export interface OutputEvidence {
  version: 1
  publications: Array<{
    callIdentity: string
    call: OutputCall
    outputs: Array<{
      port: string
      ordinal: number
      payloadHash: string
      origin: GenerationOrigin
    }>
  }>
}

export const fingerprint = (value: unknown) =>
  createHash('sha256').update(stableStringify(value)).digest('hex')
const proofHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const proofText = (value: unknown): value is string => typeof value === 'string' && value.length > 0

export function outputEvidence(value: unknown): value is OutputEvidence {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as OutputEvidence).version !== 1 ||
    !Array.isArray((value as OutputEvidence).publications)
  )
    return false
  return (value as OutputEvidence).publications.every((publication) => {
    const call = publication?.call
    return (
      !!call &&
      proofHash(call.inputFingerprint) &&
      proofHash(publication.callIdentity) &&
      fingerprint(call) === publication.callIdentity &&
      (call.kind === 'local'
        ? executionOrigin(call.execution)
        : call.kind === 'provider' &&
          Array.isArray(call.calls) &&
          call.calls.length > 0 &&
          call.calls.every((c) => c && [c.key, c.attemptId, c.requestId].every(proofText))) &&
      Array.isArray(publication.outputs) &&
      publication.outputs.every(
        (output) =>
          output &&
          proofText(output.port) &&
          Number.isSafeInteger(output.ordinal) &&
          output.ordinal >= 0 &&
          proofHash(output.payloadHash) &&
          isGenerationOrigin(output.origin) &&
          output.origin.port === output.port,
      )
    )
  })
}

export function outputCall(
  row: JobRow | undefined,
  frozen: Frozen,
  local: boolean,
): OutputCall | undefined {
  const inputFingerprint = fingerprint({
    nodeVersion: frozen.nodeVersion,
    params: frozen.params,
    inputs: frozen.inputs,
  })
  try {
    const calls = Object.entries(JSON.parse(row?.calls || '{}') as Record<string, CallRecord>).sort(
      ([a], [b]) => a.localeCompare(b),
    )
    if (!calls.length)
      return local && executionOrigin(frozen.executionOrigin)
        ? { kind: 'local', inputFingerprint, execution: { ...frozen.executionOrigin } }
        : undefined
    if (
      !calls.every(
        ([, call]) =>
          call.state === 'done' &&
          proofText(call.trace?.attemptId) &&
          proofText(call.trace?.requestId),
      )
    )
      return undefined
    return {
      kind: 'provider',
      inputFingerprint,
      calls: calls.map(([key, call]) => ({
        key,
        attemptId: call.trace!.attemptId,
        requestId: call.trace!.requestId,
      })),
    }
  } catch {
    return undefined
  }
}

export function newSubmission(
  before: JobRow | undefined,
  after: JobRow | undefined,
  call: OutputCall,
): boolean {
  if (call.kind !== 'provider') return false
  try {
    const prior = new Set(
      (JSON.parse(before?.call_history || '[]') as Array<{ id: string }>).map((event) => event.id),
    )
    return (
      JSON.parse(after?.call_history || '[]') as Array<{
        id: string
        kind: string
        callKey: string
        attemptId?: string
        requestId?: string
      }>
    ).some(
      (event) =>
        event.kind === 'submit_started' &&
        !prior.has(event.id) &&
        call.calls.some(
          (c) =>
            c.key === event.callKey &&
            c.attemptId === event.attemptId &&
            c.requestId === event.requestId,
        ),
    )
  } catch {
    return false
  }
}

export function executionOrigin(value: unknown): value is NonNullable<Frozen['executionOrigin']> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ['canvasId', 'nodeId', 'runId'].every(
      (key) =>
        typeof (value as Record<string, unknown>)[key] === 'string' &&
        !!(value as Record<string, unknown>)[key],
    )
  )
}

export function parseFrozen(raw: string | null | undefined): Frozen | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Frozen
  } catch {
    return undefined
  }
}
