import { authTables } from '@convex-dev/auth/server';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { vWorkflowId } from '@convex-dev/workflow';
import {
  runStatus,
  runMode,
  stepStatus,
  artifactRefs,
  providerCall,
} from './analysis/values';

// All public case/run functions enforce authenticated organization membership.
export default defineSchema({
  ...authTables,
  mcpConnections: defineTable({
    ownerSubject: v.string(),
    membershipId: v.id('memberships'),
    organizationId: v.id('organizations'),
    externalAuthId: v.string(),
    providerIssuer: v.string(),
    providerSubject: v.optional(v.string()),
    consentId: v.optional(v.string()),
    status: v.union(
      v.literal('pending'),
      v.literal('awaiting_consent'),
      v.literal('active'),
      v.literal('revoked'),
    ),
    createdAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index('by_owner', ['ownerSubject'])
    .index('by_flow', ['externalAuthId']),
  organizations: defineTable({ name: v.string() }),
  memberships: defineTable({
    organizationId: v.id('organizations'),
    subject: v.string(),
    issuer: v.string(),
    role: v.union(v.literal('owner'), v.literal('member')),
  })
    .index('by_identity', ['issuer', 'subject'])
    .index('by_organization_identity', ['organizationId', 'issuer', 'subject']),
  cases: defineTable({
    organizationId: v.id('organizations'),
    name: v.string(),
    createdBy: v.id('memberships'),
  }).index('by_organization', ['organizationId']),
  uploadIntents: defineTable({
    caseId: v.id('cases'),
    ownerId: v.id('memberships'),
    requestId: v.string(),
    name: v.string(),
    contentType: v.string(),
    uploadContentType: v.string(),
    size: v.number(),
    expiresAt: v.number(),
    storageId: v.optional(v.id('_storage')),
    documentVersionId: v.optional(v.id('documentVersions')),
  })
    .index('by_case_request', ['caseId', 'requestId'])
    .index('by_upload_content_type', ['uploadContentType']),
  documentVersions: defineTable({
    caseId: v.id('cases'),
    name: v.string(),
    synthetic: v.boolean(),
    storageId: v.optional(v.id('_storage')),
    sha256: v.optional(v.string()),
    contentType: v.optional(v.string()),
    size: v.optional(v.number()),
    requestId: v.optional(v.string()),
  })
    .index('by_case', ['caseId'])
    .index('by_case_request', ['caseId', 'requestId']),
  providerFiles: defineTable({
    documentVersionId: v.id('documentVersions'),
    attemptId: v.id('agentAttempts'),
    providerFileId: v.string(),
    status: v.union(
      v.literal('uploaded'),
      v.literal('deleted'),
      v.literal('cleanup_failed'),
    ),
  })
    .index('by_attempt', ['attemptId'])
    .index('by_status', ['status']),
  configurationSnapshots: defineTable({
    hash: v.string(),
    bundleJson: v.string(),
  }).index('by_hash', ['hash']),
  analysisRuns: defineTable({
    caseId: v.id('cases'),
    organizationId: v.id('organizations'),
    createdBy: v.id('memberships'),
    requestId: v.string(),
    documentVersionIds: v.array(v.id('documentVersions')),
    // Absent on runs created before live analysis existed; those are synthetic.
    mode: v.optional(runMode),
    snapshotId: v.id('configurationSnapshots'),
    workflowId: v.optional(vWorkflowId),
    status: runStatus,
    calls: v.number(),
    outputs: artifactRefs,
    error: v.optional(v.string()),
  })
    .index('by_case_request', ['caseId', 'requestId'])
    .index('by_case', ['caseId']),
  agentRuns: defineTable({
    runId: v.id('analysisRuns'),
    stepId: v.string(),
    agent: v.string(),
    status: stepStatus,
    attempts: v.number(),
    activeAttempt: v.optional(v.id('agentAttempts')),
    outputs: artifactRefs,
  })
    .index('by_run_step', ['runId', 'stepId'])
    .index('by_run', ['runId']),
  agentAttempts: defineTable({
    runId: v.id('analysisRuns'),
    agentRunId: v.id('agentRuns'),
    number: v.number(),
    status: v.union(
      v.literal('running'),
      v.literal('completed'),
      v.literal('failed'),
    ),
    error: v.optional(v.string()),
    // Actual provider response identity and reported usage for live attempts.
    provider: v.optional(providerCall),
  }).index('by_run', ['runId']),
  contextManifests: defineTable({
    runId: v.id('analysisRuns'),
    attemptId: v.id('agentAttempts'),
    configHash: v.string(),
    inputs: v.any(),
    inputArtifactIds: v.array(v.id('artifacts')),
    documentVersionIds: v.array(v.id('documentVersions')),
  })
    .index('by_attempt', ['attemptId'])
    .index('by_run', ['runId']),
  artifacts: defineTable({
    runId: v.id('analysisRuns'),
    agentRunId: v.id('agentRuns'),
    attemptId: v.id('agentAttempts'),
    output: v.string(),
    schema: v.string(),
    payload: v.any(),
    inputArtifactIds: v.array(v.id('artifacts')),
  }).index('by_run', ['runId']),
});
