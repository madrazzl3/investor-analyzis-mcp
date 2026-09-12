import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { serviceInfo } from '@investor/contracts';
import { registerDiligencePrompts } from './prompts';

export type Backend = (
  kind: 'query' | 'mutation' | 'action',
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
/** Without a token, calls are anonymous (accepted only by demo deployments). */
export function convexBackend(
  url: string,
  token?: () => Promise<string>,
): Backend {
  return async (kind, name, args) => {
    const client = new ConvexHttpClient(url);
    if (token) client.setAuth(await token());
    return kind === 'query'
      ? client.query(makeFunctionReference<'query'>(name), args)
      : kind === 'action'
        ? client.action(makeFunctionReference<'action'>(name), args)
        : client.mutation(makeFunctionReference<'mutation'>(name), args);
  };
}
export const INSTRUCTIONS =
  'Investor diligence over pitch decks and transcripts. To upload a PDF or UTF-8 transcript up to 100 MB, call prepare_upload, POST raw file bytes to its uploadUrl using the exact returned headers, then call attach_document with the uploadId and returned storageId. Never put file bytes in MCP arguments or expose upload URLs in reports. If the host cannot send file bytes over HTTP, use the website; chat attachments are not automatically accessible. Use list_documents to choose inputs. A run over uploaded documents is a live Grok investor council (when the deployment enables it): intake, a context brief, ten specialist risk lenses, a Devil’s Advocate, and a ranked report; it takes several minutes. A run over synthetic fixtures is a labeled test and never real diligence. Reuse requestId when retrying a start. Check list_analysis_runs before starting another run, and poll get_analysis_status at a modest interval. The live report ranks up to six candidate risks by VRSD score with evidence quotes, alternative explanations, founder questions, evidence to request, and coverage limits; each specialist assessment is a separate artifact named by its step. Synthetic test findings carry a disposition (verified, unresolved, rejected). Present findings as risks to investigate, never as proven misconduct, and never as an invest or pass recommendation.';
const GENERIC_FAILURE =
  'Operation failed or access denied. No successful result is available.';
/** Wraps a tool body; hosted mode never reveals backend error details. */
export async function toolResult(
  run: () => Promise<unknown>,
  describeError: (error: unknown) => string = () => GENERIC_FAILURE,
) {
  try {
    const output = { data: (await run()) ?? null };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: describeError(error) }],
    };
  }
}
export function createMcpServer(
  backend: Backend,
  options: {
    instructions?: string;
    describeError?: (error: unknown) => string;
  } = {},
): McpServer {
  const server = new McpServer(
    { name: serviceInfo.name, version: serviceInfo.version },
    { instructions: options.instructions ?? INSTRUCTIONS },
  );
  registerDiligencePrompts(server);
  const id = z.string().min(1).max(128);
  const pagination = {
    cursor: z.string().nullable().default(null),
    limit: z.number().int().min(1).max(50).default(20),
  };
  const register = (
    name: string,
    description: string,
    schema: z.ZodObject,
    kind: 'query' | 'mutation' | 'action',
    fn: string,
    map: (args: Record<string, unknown>) => Record<string, unknown> = (a) => a,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        outputSchema: z.object({ data: z.unknown() }),
        annotations: {
          readOnlyHint: kind === 'query',
          destructiveHint: name === 'cancel_analysis',
          idempotentHint:
            kind === 'query' ||
            [
              'start_analysis',
              'cancel_analysis',
              'resume_analysis',
              'attach_document',
            ].includes(name),
          openWorldHint: false,
        },
      },
      async (args) =>
        toolResult(() => backend(kind, fn, map(args)), options.describeError),
    );
  };
  register(
    'list_workspaces',
    'List workspaces accessible to this connection.',
    z.object({}),
    'query',
    'organizations:list',
  );
  register(
    'list_cases',
    'List cases for an organization you belong to.',
    z.object({ organizationId: id }),
    'query',
    'cases:list',
  );
  register(
    'create_case',
    'Create a case in an organization you belong to.',
    z.object({ organizationId: id, name: z.string().trim().min(1).max(160) }),
    'mutation',
    'cases:create',
  );
  register(
    'start_analysis',
    'Start an analysis. Uploaded documents run the live Grok workflow (paid; may be disabled on this deployment); synthetic fixtures run the labeled test workflow. Do not mix the two. Reuse requestId for retries with identical inputs.',
    z.object({
      caseId: id,
      requestId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
      documentVersionIds: z.array(id).min(1).max(10),
    }),
    'mutation',
    'runs:start',
  );
  register(
    'get_analysis_status',
    'Read persisted run mode, status, steps, attempt errors, and model usage.',
    z.object({ runId: id }),
    'query',
    'runs:get',
  );
  register(
    'list_analysis_runs',
    'List existing runs before starting another.',
    z.object({ caseId: id, ...pagination }),
    'query',
    'runs:list',
    ({ cursor, limit, ...args }) => ({
      ...args,
      paginationOpts: { cursor, numItems: limit },
    }),
  );
  register(
    'list_artifacts',
    'Read saved intermediate outputs and reports, each labeled with the step that produced it; follow pagination to retrieve further results.',
    z.object({ runId: id, ...pagination }),
    'query',
    'runs:artifacts',
    ({ cursor, limit, ...args }) => ({
      ...args,
      paginationOpts: { cursor, numItems: limit },
    }),
  );
  register(
    'get_artifact',
    'Read a saved artifact including its source references.',
    z.object({ artifactId: id }),
    'query',
    'runs:getArtifact',
  );
  register(
    'prepare_upload',
    'Prepare an authorized upload of 1–100,000,000 bytes. Reuse requestId for retries. POST raw bytes (no base64 or multipart) to uploadUrl with the exact returned Content-Type header; keep this URL private. If documentVersionId is returned, the upload is already complete. If storageId is returned, retry attach_document without reuploading. Requires an HTTP/file-capable client; otherwise use the website.',
    z.object({
      caseId: id,
      requestId: id,
      name: z.string().trim().min(1).max(200),
      contentType: z.enum(['application/pdf', 'text/plain']),
      size: z.number().int().min(1).max(100_000_000),
    }),
    'mutation',
    'uploads:prepare',
  );
  register(
    'attach_document',
    'Validate and attach the uploaded file using uploadId from prepare_upload and storageId from the raw upload response. Retry with identical IDs after an ambiguous result. Only a returned documentVersionId confirms success; do not start analysis before it is returned.',
    z.object({ uploadId: id, storageId: id }),
    'action',
    'uploadValidation:attach',
  );
  register(
    'list_documents',
    'List authorized document version metadata for a case. Uploaded documents are analyzed by the live workflow; synthetic fixtures only by the labeled test workflow.',
    z.object({ caseId: id }),
    'query',
    'documents:list',
  );
  register(
    'resume_analysis',
    'Resume a failed run within its original retry budget; completed outputs are reused and not billed again. Live runs resume only while live analysis is enabled.',
    z.object({ runId: id }),
    'mutation',
    'runs:resume',
  );
  register(
    'cancel_analysis',
    'Explicitly cancel a run; disconnecting does not cancel it.',
    z.object({ runId: id }),
    'mutation',
    'runs:cancel',
  );
  return server;
}
