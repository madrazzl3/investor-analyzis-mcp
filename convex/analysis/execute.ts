'use node';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import { fakeOutput } from './fake';
import { validatePayload } from './registry';
import {
  GrokClient,
  GrokError,
  runWithPrivateFiles,
} from '../../packages/grok/src/index';

type StepResult =
  | { status: 'completed'; outputs: Record<string, Id<'artifacts'>> }
  | { status: 'retry'; retryAfterMs: number };

export const step = internalAction({
  args: { runId: v.id('analysisRuns'), stepId: v.string() },
  handler: async (ctx, args): Promise<StepResult> => {
    const claim = await ctx.runMutation(internal.analysis.state.begin, args);
    if (claim.completed) return { status: 'completed', outputs: claim.outputs };
    const attemptId = claim.attemptId;
    try {
      const context = await ctx.runQuery(internal.analysis.state.context, {
        attemptId,
      });
      if (!context.live) {
        const outputs = fakeOutput(context.agent.id, context.inputs);
        return {
          status: 'completed',
          outputs: await ctx.runMutation(internal.analysis.state.publish, {
            attemptId,
            outputs,
          }),
        };
      }
      const live = context.live;
      // Blobs are read server-side from private storage; nothing is public.
      const files = [];
      for (const source of live.attachments) {
        const blob = await ctx.storage.get(source.storageId);
        if (!blob) throw new Error('Source file missing');
        files.push({
          documentVersionId: source.documentVersionId,
          name: source.name,
          blob: new Blob([blob], { type: source.contentType }),
        });
      }
      const result = await runWithPrivateFiles(
        new GrokClient(process.env.XAI_API_KEY ?? ''),
        {
          model: live.model,
          prompt: context.prompt,
          inputs: context.inputs,
          schema: live.outputSchema,
          maxOutputTokens: live.maxOutputTokens,
          maxToolCalls: live.maxToolCalls,
          timeoutMs: live.timeoutMs,
          files,
          validate(output) {
            const value = output as Record<string, unknown>;
            if (
              !value ||
              typeof value !== 'object' ||
              Array.isArray(value) ||
              Object.keys(value).sort().join('|') !==
                Object.keys(live.outputSchemas).sort().join('|')
            )
              throw new Error('Output ports mismatch');
            for (const [port, schema] of Object.entries(live.outputSchemas))
              validatePayload(schema, value[port]);
          },
        },
        {
          uploaded: async (source, providerFileId) => {
            await ctx.runMutation(internal.providerFiles.record, {
              attemptId,
              documentVersionId:
                source.documentVersionId as Id<'documentVersions'>,
              providerFileId,
            });
          },
          deleted: async (providerFileId) => {
            await ctx.runMutation(internal.providerFiles.mark, {
              attemptId,
              providerFileId,
              status: 'deleted',
            });
          },
          cleanupFailed: async (providerFileId) => {
            await ctx.runMutation(internal.providerFiles.mark, {
              attemptId,
              providerFileId,
              status: 'cleanup_failed',
            });
          },
        },
      );
      return {
        status: 'completed',
        outputs: await ctx.runMutation(internal.analysis.state.publish, {
          attemptId,
          outputs: result.output,
          provider: {
            model: result.model,
            responseId: result.responseId,
            usage: result.usage,
          },
        }),
      };
    } catch (error) {
      // Only sanitized categories are persisted; provider bodies never are.
      const grok = error instanceof GrokError ? error : null;
      const retry = await ctx.runMutation(internal.analysis.state.failAttempt, {
        attemptId,
        error: grok?.code ?? 'execution_failed',
        retryable: grok?.retryable ?? false,
      });
      if (retry) return { status: 'retry', ...retry };
      throw new Error('Analysis step failed');
    }
  },
});

/** Actions stop after 10 minutes, so older running attempts are abandoned. */
const ABANDONED_ATTEMPT_MS = 15 * 60_000;

/**
 * Deletes provider copies left by crashed attempts or failed cleanup. A file
 * already missing at the provider counts as deleted.
 */
export const reconcileProviderFiles = internalAction({
  args: {},
  handler: async (ctx): Promise<{ deleted: number; failed: number }> => {
    const files = await ctx.runQuery(internal.providerFiles.abandoned, {
      before: Date.now() - ABANDONED_ATTEMPT_MS,
    });
    if (!files.length) return { deleted: 0, failed: 0 };
    const client = new GrokClient(process.env.XAI_API_KEY ?? '');
    let deleted = 0,
      failed = 0;
    for (const file of files) {
      let status: 'deleted' | 'cleanup_failed' = 'deleted';
      try {
        await client.deleteFile(file.providerFileId);
        deleted++;
      } catch {
        status = 'cleanup_failed';
        failed++;
      }
      await ctx.runMutation(internal.providerFiles.mark, {
        attemptId: file.attemptId,
        providerFileId: file.providerFileId,
        status,
      });
    }
    return { deleted, failed };
  },
});
