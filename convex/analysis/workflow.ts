import {
  defineWorkflow,
  vWorkflowId,
  vResultValidator,
} from '@convex-dev/workflow';
import { components, internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import { v } from 'convex/values';
export const diligence = defineWorkflow(components.workflow, {
  args: { runId: v.id('analysisRuns') },
  returns: v.null(),
}).handler(async (step, args): Promise<null> => {
  const plan = await step.runQuery(internal.analysis.state.plan, args);
  const completed = new Set<string>();
  while (completed.size < plan.steps.length) {
    const ready = plan.steps
      .filter(
        (s) =>
          !completed.has(s.id) && s.dependencies.every((d) => completed.has(d)),
      )
      .slice(0, plan.maxParallelSteps);
    if (!ready.length) throw new Error('No ready workflow steps');
    await Promise.all(
      ready.map(async (s) => {
        // Automatic action retries stay off: an ambiguous provider failure may
        // already be billed. The step itself decides, within the snapshot's
        // retry policy and budgets, whether a classified failure gets another
        // attempt; terminal failures throw and fail the run.
        let runAfter = 0;
        for (;;) {
          const result = await step.runAction(
            internal.analysis.execute.step,
            { runId: args.runId, stepId: s.id },
            { retry: false, ...(runAfter ? { runAfter } : {}) },
          );
          if (result.status === 'completed') return;
          runAfter = result.retryAfterMs;
        }
      }),
    );
    ready.forEach((s) => completed.add(s.id));
  }
  await step.runMutation(internal.analysis.state.finish, args);
  return null;
});
export const onComplete = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.object({ runId: v.id('analysisRuns') }),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.context.runId);
    if (
      !run ||
      run.workflowId !== args.workflowId ||
      run.status === 'completed' ||
      run.status === 'cancelled'
    )
      return;
    await ctx.db.patch(run._id, {
      status: args.result.kind === 'canceled' ? 'cancelled' : 'failed',
      // Keep a specific step failure (for example "extract: invalid_output").
      error:
        run.error ??
        (args.result.kind === 'success'
          ? 'missing_final_commit'
          : 'workflow_failed'),
    });
  },
});
