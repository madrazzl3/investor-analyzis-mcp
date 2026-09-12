import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { LocalGrok } from '../../../packages/analysis/src/local-grok.js';

export function createDiskMcpServer(runtime: LocalGrok) {
  const server = new McpServer(
    { name: 'investor-diligence-local', version: '0.1.0' },
    {
      instructions:
        'Single-user local investor diligence. Use analyze_files only with paths explicitly supplied by the user. Originals and results are saved on this machine; source attachments are sent to xAI for analysis. Poll get_report for progress. Repeated identical inputs and configuration reuse the existing run. Present candidate risks with citations and uncertainty, never proven misconduct or an invest/pass recommendation. The local process must stay open; resume_analysis explicitly resumes interrupted work within its original budgets.',
    },
  );
  const id = z.string().regex(/^[a-f0-9]{64}$/);
  const register = (
    name: string,
    description: string,
    schema: z.ZodObject,
    readOnly: boolean,
    action: (args: Record<string, unknown>) => unknown,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: false,
          openWorldHint: !readOnly,
        },
      },
      async (args) => {
        try {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(await action(args)),
              },
            ],
          };
        } catch {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Operation failed. Check file paths, format (PDF/TXT/MD, 20 MiB combined), saved run state, and local configuration. No successful result is available.',
              },
            ],
          };
        }
      },
    );
  };
  register(
    'analyze_files',
    'Snapshot local PDF/TXT/MD files and start the Grok council. Returns a run ID. Identical inputs, case name and configuration reuse a run.',
    z.object({
      paths: z.array(z.string().min(1)).min(1).max(10),
      caseName: z.string().min(1).max(160).optional(),
    }),
    false,
    (args) =>
      runtime.start(
        args.paths as string[],
        args.caseName as string | undefined,
      ),
  );
  register(
    'get_report',
    'Read progress, attempts, provider usage and the completed report. No model calls.',
    z.object({ runId: id }),
    true,
    (args) => runtime.get(args.runId as string),
  );
  register(
    'list_analysis_runs',
    'List saved local runs.',
    z.object({}),
    true,
    () => runtime.list(),
  );
  register(
    'get_artifact',
    'Read a saved, hash-checked intermediate artifact from this run.',
    z.object({ runId: id, artifactId: id }),
    true,
    (args) => runtime.artifact(args.runId as string, args.artifactId as string),
  );
  register(
    'resume_analysis',
    'Resume interrupted or failed work, preserving accepted artifacts and consumed budgets. May make paid model calls. Cancelled/completed runs remain terminal.',
    z.object({ runId: id }),
    false,
    (args) => runtime.resume(args.runId as string),
  );
  register(
    'cancel_analysis',
    'Cancel remaining work. Already submitted requests may still be billed.',
    z.object({ runId: id }),
    false,
    (args) => runtime.cancel(args.runId as string),
  );
  register(
    'cleanup_provider_files',
    'Retry deletion of tracked xAI files after a run has stopped.',
    z.object({ runId: id }),
    false,
    (args) => runtime.cleanup(args.runId as string),
  );
  return server;
}
