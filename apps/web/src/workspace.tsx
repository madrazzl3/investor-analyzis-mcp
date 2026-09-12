import { useRef, useState } from 'react';
import {
  useAction,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import {
  PendingStart,
  selectCase,
  selectOrganization,
  type WorkspaceSelection,
} from './workspace-state';

/** Mounted only after Convex itself confirms authentication. All APIs also authorize server-side. */
export function Workspace({
  selection,
  onSelection,
}: {
  selection: WorkspaceSelection;
  onSelection: (value: WorkspaceSelection) => void;
}) {
  const organizations = useQuery(api.organizations.list);
  const organizationId = selection.organizationId as
    Id<'organizations'> | undefined;
  const cases = useQuery(
    api.cases.list,
    organizationId ? { organizationId } : 'skip',
  );
  const create = useMutation(api.cases.create);
  const createPersonal = useMutation(api.organizations.createPersonal);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="workspace-content">
      <div className="workspace-intro">
        <span className="eyebrow">MY WORKSPACE</span>
        <h1>Follow the evidence.</h1>
        <p>
          Cases and saved analysis are shared with your authorized MCP
          connections.
        </p>
      </div>
      <label className="auth-label">
        Organization
        <select
          value={organizationId ?? ''}
          onChange={(e) => onSelection(selectOrganization(e.target.value))}
        >
          <option value="">Choose an organization</option>
          {organizations?.map((org) => (
            <option key={org._id} value={org._id}>
              {org.name}
            </option>
          ))}
        </select>
      </label>
      {organizations?.length === 0 && (
        <div>
          <p>No organization membership yet.</p>
          <button
            className="button primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const id = await createPersonal({});
                onSelection(selectOrganization(id));
              } catch {
                setError('Workspace creation failed. Please retry.');
              } finally {
                setBusy(false);
              }
            }}
          >
            Create my workspace
          </button>
        </div>
      )}
      {organizations === undefined && (
        <p role="status">Loading authorized organizations…</p>
      )}
      {!organizationId && error && <p role="alert">{error}</p>}
      {organizationId && (
        <section className="workspace-card">
          <h2>Your cases</h2>
          <div className="workspace-case-list">
            {cases?.map((item) => (
              <button
                className={`button ${selection.caseId === item._id ? 'primary' : 'secondary'}`}
                key={item._id}
                onClick={() => onSelection(selectCase(selection, item._id))}
              >
                {item.name}
              </button>
            ))}
          </div>
          {cases?.length === 0 && <p>Create your first case.</p>}
          <form
            className="workspace-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy || !name.trim()) return;
              setBusy(true);
              setError('');
              try {
                const caseId = await create({ organizationId, name });
                onSelection(selectCase(selection, caseId));
                setName('');
              } catch {
                setError(
                  'Case creation failed. Check your access and connection before trying again.',
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <input
              aria-label="Company or case name"
              placeholder="Company or case name"
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <button
              className="button secondary"
              disabled={busy || !name.trim()}
            >
              Create case
            </button>
          </form>
          {error && <p role="alert">{error}</p>}
        </section>
      )}
      {selection.caseId && (
        <CaseWorkspace
          key={selection.caseId}
          caseId={selection.caseId as Id<'cases'>}
          runId={selection.runId as Id<'analysisRuns'> | undefined}
          onRun={(runId) => onSelection({ ...selection, runId })}
        />
      )}
    </div>
  );
}

function CaseWorkspace({
  caseId,
  runId,
  onRun,
}: {
  caseId: Id<'cases'>;
  runId?: Id<'analysisRuns'>;
  onRun: (runId: string) => void;
}) {
  const runs = usePaginatedQuery(
    api.runs.list,
    { caseId },
    { initialNumItems: 20 },
  );
  const documents = useQuery(api.documents.list, { caseId });
  const capabilities = useQuery(api.runs.capabilities);
  const addSyntheticDocument = useMutation(api.cases.addSyntheticDocument);
  const start = useMutation(api.runs.start);
  const starts = useRef(new PendingStart());
  // Inputs are pinned with their request ID so an ambiguous retry is identical.
  const pendingDocuments = useRef<Id<'documentVersions'>[] | undefined>(
    undefined,
  );
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<'live' | 'synthetic' | null>(null);
  const [error, setError] = useState('');
  const uploaded = (documents ?? []).filter((doc) => !doc.synthetic);
  async function launch(
    mode: 'live' | 'synthetic',
    inputs: () => Promise<Id<'documentVersions'>[]>,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(mode);
    setError('');
    const key = `${caseId}:${mode}`;
    const requestId = starts.current.key(key, () => crypto.randomUUID());
    try {
      pendingDocuments.current ??= await inputs();
      const id = await start({
        caseId,
        requestId,
        documentVersionIds: pendingDocuments.current,
      });
      starts.current.accepted(key);
      pendingDocuments.current = undefined;
      onRun(id);
    } catch {
      setError(
        'Start was not acknowledged. Retry uses the same request ID and documents to avoid duplicate runs.',
      );
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }
  return (
    <>
      <Documents caseId={caseId} documents={documents} />
      <section className="workspace-card">
        <h2>Case assistant</h2>
        <p>
          Use these actions to control your case. Conversational model chat is
          not connected yet.
        </p>
        <div className="workspace-notice">
          Live analysis sends this case’s uploaded documents (up to 10) to Grok
          for an investor council: intake, a context brief, ten specialist
          lenses, a Devil’s Advocate, and a ranked risk report. It takes several
          minutes and uses about 14 paid model calls. Results are candidate
          risks for human review, not conclusions of misconduct.
        </div>
        <button
          className="button primary"
          disabled={
            !!busy ||
            !capabilities?.liveAnalysis ||
            !uploaded.length ||
            uploaded.length > 10
          }
          onClick={() =>
            void launch('live', async () =>
              uploaded.map((doc) => doc.documentVersionId),
            )
          }
        >
          {busy === 'live' ? 'Starting…' : 'Run live analysis'}
        </button>
        {capabilities && !capabilities.liveAnalysis && (
          <p>Live analysis is not enabled on this deployment.</p>
        )}
        {capabilities?.liveAnalysis && !uploaded.length && (
          <p>Upload a deck or transcript to enable live analysis.</p>
        )}
        {uploaded.length > 10 && (
          <p>Live analysis accepts at most 10 documents per run.</p>
        )}
        <button
          className="button secondary"
          disabled={!!busy}
          onClick={() =>
            void launch('synthetic', async () => [
              await addSyntheticDocument({ caseId }),
            ])
          }
        >
          {busy === 'synthetic' ? 'Starting…' : 'Start synthetic workflow test'}
        </button>
        <p>
          The synthetic test saves clearly labeled sample outputs. No investor
          documents are analyzed.
        </p>
        {error && <p role="alert">{error}</p>}
      </section>
      <section className="workspace-card">
        <h2>Saved analyses</h2>
        <p>Opening a saved analysis does not restart it.</p>
        <div className="workspace-case-list">
          {runs.results.map((run) => (
            <button
              className={`button ${runId === run._id ? 'primary' : 'secondary'}`}
              key={run._id}
              onClick={() => onRun(run._id)}
            >
              {new Date(run._creationTime).toLocaleString()} ·{' '}
              {run.mode === 'live' ? 'live' : 'synthetic'} · {run.status}
            </button>
          ))}
        </div>
        {runs.status === 'LoadingFirstPage' && (
          <p role="status">Loading analyses…</p>
        )}
        {runs.status === 'Exhausted' && runs.results.length === 0 && (
          <p>No saved analyses yet.</p>
        )}
        {runs.status === 'CanLoadMore' && (
          <button className="text-button" onClick={() => runs.loadMore(20)}>
            Load older analyses
          </button>
        )}
      </section>
      {runId && <RunDetails key={runId} runId={runId} />}
    </>
  );
}
function RunDetails({ runId }: { runId: Id<'analysisRuns'> }) {
  const details = useQuery(api.runs.get, { runId });
  const artifacts = usePaginatedQuery(
    api.runs.artifacts,
    { runId },
    { initialNumItems: 20 },
  );
  const cancel = useMutation(api.runs.cancel);
  const resume = useMutation(api.runs.resume);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function operate(operation: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch {
      setError(
        'The operation failed. Check your access, connection, and run state.',
      );
    } finally {
      setBusy(false);
    }
  }
  if (!details) return <p role="status">Loading saved run…</p>;
  const live = details.run.mode === 'live';
  const tokens = details.attempts.reduce(
    (sum, attempt) => sum + (attempt.usage?.totalTokens ?? 0),
    0,
  );
  const models = [
    ...new Set(details.attempts.flatMap((a) => (a.model ? [a.model] : []))),
  ];
  return (
    <section className="workspace-card">
      <div className="section-heading">
        <h2>Analysis · {details.run.status}</h2>
        <span className="tiny-label">
          {live ? 'LIVE GROK RUN' : 'SYNTHETIC TEST RUN'}
        </span>
      </div>
      <p className="workspace-id">{runId}</p>
      {live && (
        <p>
          Model {models.join(', ') || 'pending'} · {details.run.calls} calls ·{' '}
          {tokens.toLocaleString()} reported tokens
        </p>
      )}
      <ul>
        {details.steps.map((step) => {
          const failures = details.attempts
            .filter((a) => a.agentRunId === step._id && a.error)
            .map((a) => a.error);
          return (
            <li key={step._id}>
              {step.stepId}: <strong>{step.status}</strong> · {step.attempts}{' '}
              attempts
              {failures.length > 0 && ` · ${failures.join(', ')}`}
            </li>
          );
        })}
      </ul>
      {details.run.error && <p role="alert">{details.run.error}</p>}
      {['queued', 'running'].includes(details.run.status) && (
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void operate(() => cancel({ runId }))}
        >
          Cancel analysis
        </button>
      )}
      {['failed', 'incomplete'].includes(details.run.status) && (
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void operate(() => resume({ runId }))}
        >
          Resume analysis
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <h3>Report and intermediate artifacts</h3>
      <p>
        Outputs retain their source references. A completed workflow is not a
        finding of misconduct.
      </p>
      {artifacts.results.map((artifact) => (
        <details
          key={artifact._id}
          open={artifact.output === 'report'}
          className="artifact-view"
        >
          <summary>
            {artifact.stepId ?? artifact.output} · {artifact.output} ·{' '}
            {artifact.schema}
          </summary>
          <pre>{JSON.stringify(artifact.payload, null, 2)}</pre>
          <small>
            Artifact {artifact._id} · Input artifacts:{' '}
            {artifact.inputArtifactIds.join(', ') || 'none'}
          </small>
        </details>
      ))}
      {artifacts.status === 'CanLoadMore' && (
        <button className="text-button" onClick={() => artifacts.loadMore(20)}>
          Load more artifacts
        </button>
      )}
    </section>
  );
}

function Documents({
  caseId,
  documents,
}: {
  caseId: Id<'cases'>;
  documents: FunctionReturnType<typeof api.documents.list> | undefined;
}) {
  const prepare = useMutation(api.uploads.prepare);
  const attach = useAction(api.uploadValidation.attach);
  const receipt = useRef<{
    uploadId: Id<'uploadIntents'>;
    storageId: Id<'_storage'>;
  } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const request = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <section className="workspace-card">
      <h2>Documents</h2>
      <p>
        PDF decks and UTF-8 text transcripts, up to 100 MB (100,000,000 bytes)
        each. Files stay in this case; demo mode never receives them.
      </p>
      <ul>
        {documents?.map((doc) => (
          <li key={doc.documentVersionId}>
            {doc.name} ·{' '}
            {doc.synthetic ? 'synthetic fixture' : 'uploaded source'}
          </li>
        ))}
      </ul>
      <form
        className="workspace-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!file || busy) return;
          const form = e.currentTarget;
          if (!file.size || file.size > 100_000_000) {
            setMessage(
              'Choose a nonempty file of up to 100 MB (100,000,000 bytes).',
            );
            return;
          }
          const contentType = file.name.toLowerCase().endsWith('.pdf')
            ? 'application/pdf'
            : 'text/plain';
          setBusy(true);
          setMessage('');
          request.current ??= crypto.randomUUID();
          try {
            if (!receipt.current) {
              const prepared = await prepare({
                caseId,
                requestId: request.current,
                name: file.name,
                contentType,
                size: file.size,
              });
              if (!prepared.documentVersionId) {
                let storageId = prepared.storageId;
                if (!storageId) {
                  const response = await fetch(prepared.uploadUrl!, {
                    method: 'POST',
                    headers: prepared.headers,
                    body: file,
                  });
                  if (!response.ok) throw new Error('Upload failed');
                  const result: unknown = await response.json();
                  if (
                    !result ||
                    typeof result !== 'object' ||
                    !('storageId' in result) ||
                    typeof result.storageId !== 'string'
                  )
                    throw new Error('Invalid upload receipt');
                  storageId = result.storageId as Id<'_storage'>;
                }
                receipt.current = { uploadId: prepared.uploadId, storageId };
              }
            }
            if (receipt.current) {
              setMessage('Validating uploaded file…');
              await attach(receipt.current);
            }
            receipt.current = null;
            request.current = null;
            setFile(null);
            form.reset();
            setMessage('Document saved. It is included in the next live run.');
          } catch {
            setMessage(
              'Upload was not acknowledged. Retry the same file to safely reuse this request.',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          aria-label="Upload a PDF or text transcript"
          type="file"
          accept=".pdf,.txt,application/pdf,text/plain"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            receipt.current = null;
            request.current = null;
            setMessage('');
          }}
        />
        <button className="button secondary" disabled={!file || busy}>
          {busy ? 'Uploading…' : 'Save document'}
        </button>
      </form>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
