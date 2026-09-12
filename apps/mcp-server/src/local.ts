import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import { ConvexError } from 'convex/values';
import { z } from 'zod';
import {
  createMcpServer,
  INSTRUCTIONS,
  toolResult,
  type Backend,
} from './mcp.js';

// Local demo mode: the stdio process runs on the presenter's machine, calls a
// demo Convex deployment anonymously, and can upload files the user names.

const CONTENT_TYPES: Record<string, 'application/pdf' | 'text/plain'> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/plain',
};
const MAX_BYTES = 100_000_000;
const MAX_WAIT_SECONDS = 50;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

type Document = {
  name: string;
  contentType: 'application/pdf' | 'text/plain';
  bytes: Uint8Array<ArrayBuffer>;
};
type Prepared = {
  uploadId: string;
  documentVersionId?: string;
  uploadUrl?: string;
  headers?: Record<string, string>;
  storageId?: string;
};
type RunStatus = {
  run: {
    _id: string;
    mode: string;
    status: string;
    error?: string;
    outputs: Record<string, string>;
  };
  steps: { stepId: string; status: string; attempts: number }[];
  attempts: { usage?: { totalTokens: number | null } }[];
};
export type LocalDeps = {
  fetch?: typeof fetch;
  pollIntervalMs?: number;
};

export const LOCAL_INSTRUCTIONS = `${INSTRUCTIONS} Local demo mode: this server runs on the user's machine without sign-in and uses one shared demo workspace. Prefer analyze_files with absolute paths to local .pdf, .txt, or .md files: it creates (or reuses, by name) a case, uploads the files, and starts the analysis in one call. Use upload_file or upload_text to add documents to an existing case, then start_analysis. Use get_report with waitSeconds to wait for and read the final report; call it again until the run is completed, failed, or cancelled. Only upload files the user explicitly names.`;

/** Local users need the actual reason (for example, live analysis disabled). */
export function describeLocalError(error: unknown) {
  if (error instanceof ConvexError) return String(error.data);
  if (error instanceof Error) return error.message;
  return 'Operation failed';
}

/** CONVEX_URL from the environment, else only that line of the repo's .env.local. */
export function resolveConvexUrl(
  env: NodeJS.ProcessEnv,
  envFile = new URL('../../../.env.local', import.meta.url),
) {
  if (env.CONVEX_URL) return env.CONVEX_URL;
  try {
    const line = readFileSync(envFile, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('CONVEX_URL='));
    return line?.slice('CONVEX_URL='.length).trim().replace(/^"|"$/g, '');
  } catch {
    return undefined;
  }
}

// Deterministic request IDs make retries idempotent: the same bytes in the same
// case reuse one document, and the same documents reuse one run.
function digest(...parts: (string | Uint8Array)[]) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return `local-${hash.digest('hex').slice(0, 40)}`;
}

export async function readDocument(path: string): Promise<Document> {
  const full = resolve(path.replace(/^~(?=$|\/)/, homedir()));
  const contentType = CONTENT_TYPES[extname(full).toLowerCase()];
  if (!contentType)
    throw new Error(
      `Unsupported file type: ${basename(full)} (use .pdf, .txt, or .md)`,
    );
  const bytes = new Uint8Array(await readFile(full));
  return { name: basename(full), contentType, bytes };
}

export async function uploadDocument(
  backend: Backend,
  fetchFn: typeof fetch,
  caseId: string,
  { name, contentType, bytes }: Document,
) {
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES)
    throw new Error(`${name} must be 1–100,000,000 bytes`);
  const prepared = (await backend('mutation', 'uploads:prepare', {
    caseId,
    requestId: digest(name, contentType, bytes),
    name,
    contentType,
    size: bytes.byteLength,
  })) as Prepared;
  if (prepared.documentVersionId)
    return { documentVersionId: prepared.documentVersionId, name };
  let storageId = prepared.storageId;
  if (!storageId) {
    const response = await fetchFn(prepared.uploadUrl!, {
      method: 'POST',
      headers: prepared.headers,
      body: bytes,
    });
    if (!response.ok)
      throw new Error(`Storage upload failed (HTTP ${response.status})`);
    ({ storageId } = (await response.json()) as { storageId: string });
  }
  const { documentVersionId } = (await backend(
    'action',
    'uploadValidation:attach',
    { uploadId: prepared.uploadId, storageId },
  )) as { documentVersionId: string };
  return { documentVersionId, name };
}

export function createLocalMcpServer(backend: Backend, deps: LocalDeps = {}) {
  const fetchFn = deps.fetch ?? fetch;
  const pollIntervalMs = deps.pollIntervalMs ?? 5000;
  // The demo actor's workspace is created on first use (idempotently), so
  // list_workspaces is never empty for a fresh deployment.
  let workspace: Promise<string> | undefined;
  const ensureWorkspace = () =>
    (workspace ??= (
      backend('mutation', 'organizations:createPersonal', {}) as Promise<string>
    ).catch((error) => {
      workspace = undefined;
      throw error;
    }));
  const server = createMcpServer(
    async (kind, name, args) => {
      if (name === 'organizations:list') await ensureWorkspace();
      return backend(kind, name, args);
    },
    { instructions: LOCAL_INSTRUCTIONS, describeError: describeLocalError },
  );
  const id = z.string().min(1).max(128);
  const register = (
    name: string,
    description: string,
    inputSchema: z.ZodObject,
    readOnly: boolean,
    run: (args: Record<string, unknown>) => Promise<unknown>,
  ) =>
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        outputSchema: z.object({ data: z.unknown() }),
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      (args) => toolResult(() => run(args), describeLocalError),
    );

  const startRun = async (caseId: string, documentVersionIds: string[]) =>
    (await backend('mutation', 'runs:start', {
      caseId,
      requestId: digest(...documentVersionIds),
      documentVersionIds,
    })) as string;

  register(
    'analyze_files',
    'Analyze local pitch decks (.pdf) and transcripts (.txt, .md) in one call: reuses the demo case with this name (default: the first file name) or creates it, uploads the files, and starts the live Grok investor council. Returns caseId and runId; then call get_report. Analyzing the same files in the same case returns the existing run instead of paying again; choose a new caseName for a fresh run. Only use paths the user explicitly provided.',
    z.object({
      paths: z.array(z.string().min(1)).min(1).max(10),
      caseName: z.string().trim().min(1).max(160).optional(),
    }),
    false,
    async (args) => {
      const { paths, caseName } = args as {
        paths: string[];
        caseName?: string;
      };
      // Read everything first so a bad path fails before anything is created.
      const documents = await Promise.all(paths.map(readDocument));
      const name = caseName ?? documents[0]!.name;
      const organizationId = await ensureWorkspace();
      const cases = (await backend('query', 'cases:list', {
        organizationId,
      })) as { _id: string; name: string }[];
      const caseId =
        cases.find((c) => c.name === name)?._id ??
        ((await backend('mutation', 'cases:create', {
          organizationId,
          name,
        })) as string);
      const uploaded = [];
      for (const document of documents)
        uploaded.push(await uploadDocument(backend, fetchFn, caseId, document));
      const runId = await startRun(
        caseId,
        uploaded.map((d) => d.documentVersionId),
      );
      return {
        caseId,
        caseName: name,
        runId,
        documents: uploaded,
        next: 'Call get_report with this runId and waitSeconds to follow progress. A live council run usually takes several minutes.',
      };
    },
  );
  register(
    'upload_file',
    'Upload one local .pdf, .txt, or .md file (absolute path) to a case. Returns documentVersionId for start_analysis. Re-uploading the same file to the same case returns the existing document. Only use paths the user explicitly provided.',
    z.object({ caseId: id, path: z.string().min(1) }),
    false,
    async (args) =>
      uploadDocument(
        backend,
        fetchFn,
        args.caseId as string,
        await readDocument(args.path as string),
      ),
  );
  register(
    'upload_text',
    'Upload pasted transcript or notes text as a UTF-8 document in a case. Returns documentVersionId for start_analysis.',
    z.object({
      caseId: id,
      name: z.string().trim().min(1).max(200),
      text: z.string().min(1).max(1_000_000),
    }),
    false,
    async (args) =>
      uploadDocument(backend, fetchFn, args.caseId as string, {
        name: args.name as string,
        contentType: 'text/plain',
        bytes: new TextEncoder().encode(args.text as string),
      }),
  );
  register(
    'get_report',
    `Read a run's progress and, once completed, its final report. waitSeconds (0–${MAX_WAIT_SECONDS}) waits for the run to finish before answering; call again while status is queued or running.`,
    z.object({
      runId: id,
      waitSeconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(0),
    }),
    true,
    async (args) => {
      const deadline = Date.now() + (args.waitSeconds as number) * 1000;
      for (;;) {
        const status = (await backend('query', 'runs:get', {
          runId: args.runId,
        })) as RunStatus;
        const { run, steps } = status;
        if (TERMINAL.has(run.status) || Date.now() >= deadline) {
          const reportId = run.outputs.report;
          const report =
            run.status === 'completed' && reportId
              ? ((await backend('query', 'runs:getArtifact', {
                  artifactId: reportId,
                })) as { payload: unknown })
              : null;
          return {
            runId: run._id,
            mode: run.mode,
            status: run.status,
            error: run.error ?? null,
            progress: `${steps.filter((s) => s.status === 'completed').length}/${steps.length} steps completed`,
            steps: steps.map((s) => ({
              step: s.stepId,
              status: s.status,
              attempts: s.attempts,
            })),
            totalTokens: status.attempts.reduce(
              (sum, a) => sum + (a.usage?.totalTokens ?? 0),
              0,
            ),
            reportArtifactId: reportId ?? null,
            report: report?.payload ?? null,
            ...(TERMINAL.has(run.status)
              ? {}
              : { next: 'Still running; call get_report again.' }),
          };
        }
        await new Promise((r) =>
          setTimeout(r, Math.min(pollIntervalMs, deadline - Date.now())),
        );
      }
    },
  );
  return server;
}
