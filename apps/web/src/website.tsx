import {
  Component,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';
import { ConvexReactClient, useConvexAuth } from 'convex/react';
import { ConvexAuthProvider, useAuthActions } from '@convex-dev/auth/react';
import { Workspace } from './workspace';
import { type WorkspaceSelection, visibleSelection } from './workspace-state';

const deploymentUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
const client = deploymentUrl ? new ConvexReactClient(deploymentUrl) : null;

export function Website({
  Demo,
}: {
  Demo: ComponentType<{ onWorkspace: () => void }>;
}) {
  if (!client) return <Unconfigured Demo={Demo} />;
  return (
    <ConvexAuthProvider client={client}>
      <AuthenticatedWebsite Demo={Demo} />
    </ConvexAuthProvider>
  );
}
function Unconfigured({
  Demo,
}: {
  Demo: ComponentType<{ onWorkspace: () => void }>;
}) {
  const [mode, setMode] = useState<'demo' | 'workspace'>('demo');
  if (mode === 'demo') return <Demo onWorkspace={() => setMode('workspace')} />;
  return (
    <WorkspaceShell onDemo={() => setMode('demo')}>
      <div className="workspace-card">
        <h1>Workspace connection unavailable</h1>
        <p>
          This website has not been configured for sign-in. Explore the
          synthetic demo while setup is completed.
        </p>
      </div>
    </WorkspaceShell>
  );
}
function AuthenticatedWebsite({
  Demo,
}: {
  Demo: ComponentType<{ onWorkspace: () => void }>;
}) {
  const [mode, setMode] = useState<'demo' | 'workspace'>('demo');
  const [selection, setSelection] = useState<WorkspaceSelection>({});
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signOut } = useAuthActions();
  useEffect(() => {
    if (!isAuthenticated && !isLoading) setSelection({});
  }, [isAuthenticated, isLoading]);
  if (mode === 'demo') return <Demo onWorkspace={() => setMode('workspace')} />;
  return (
    <WorkspaceShell onDemo={() => setMode('demo')}>
      {isLoading ? (
        <p role="status">Verifying session…</p>
      ) : isAuthenticated ? (
        <>
          <button
            className="text-button workspace-signout"
            onClick={() => {
              setSelection({});
              void signOut();
            }}
          >
            Sign out
          </button>
          <PrivateBoundary key={selection.organizationId ?? 'organizations'}>
            <Workspace
              selection={visibleSelection(mode, selection)}
              onSelection={setSelection}
            />
          </PrivateBoundary>
        </>
      ) : (
        <SignIn onAuthenticated={() => setSelection({})} />
      )}
    </WorkspaceShell>
  );
}
function WorkspaceShell({
  children,
  onDemo,
}: {
  children: ReactNode;
  onDemo: () => void;
}) {
  const [connect, setConnect] = useState(false);
  const endpoint = import.meta.env.VITE_MCP_URL as string | undefined;
  return (
    <div className="private-shell">
      <header className="topbar">
        <b className="brand">diligent.</b>
        <div className="top-actions">
          <button
            className="button secondary"
            onClick={() => setConnect(!connect)}
          >
            Connect via MCP
          </button>
          <div className="mode-switch">
            <button onClick={onDemo}>Demo mode</button>
            <button className="selected">My workspace</button>
          </div>
        </div>
      </header>
      {connect && (
        <section className="workspace-card">
          <h2>Connect your AI application</h2>
          <p>
            ChatGPT, Claude, and Grok are launch targets. Their authenticated
            connection flows have not yet been verified.
          </p>
          {endpoint ? (
            <>
              <code>{endpoint}</code>
              <button
                className="button secondary"
                onClick={() => void navigator.clipboard.writeText(endpoint)}
              >
                Copy MCP URL
              </button>
            </>
          ) : (
            <p>
              The hosted MCP endpoint has not been configured for this website.
            </p>
          )}
          <p>
            Add the remote endpoint using your client’s supported MCP settings,
            then follow its authorization flow. Client support depends on the
            product and plan.
          </p>
        </section>
      )}
      {children}
    </div>
  );
}
function SignIn({ onAuthenticated }: { onAuthenticated: () => void }) {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<'signIn' | 'signUp'>('signIn');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <section className="workspace-card signin-card">
      <span className="eyebrow">YOUR INVESTMENT WORKSPACE</span>
      <h1>{flow === 'signIn' ? 'Welcome back.' : 'Create your account.'}</h1>
      <div className="auth-tabs">
        <button
          className={flow === 'signIn' ? 'selected' : ''}
          onClick={() => {
            setFlow('signIn');
            setError('');
          }}
        >
          Sign in
        </button>
        <button
          className={flow === 'signUp' ? 'selected' : ''}
          onClick={() => {
            setFlow('signUp');
            setError('');
          }}
        >
          Create account
        </button>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          const form = e.currentTarget;
          const data = new FormData(form);
          setBusy(true);
          setError('');
          try {
            await signIn('password', {
              email: String(data.get('email')),
              password: String(data.get('password')),
              flow,
            });
            form.reset();
            onAuthenticated();
          } catch {
            setError(
              'Sign-in was not completed. Check your details and try again.',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="auth-label">
          Email
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label className="auth-label">
          Password
          <input
            key={flow}
            name="password"
            type="password"
            autoComplete={
              flow === 'signIn' ? 'current-password' : 'new-password'
            }
            minLength={flow === 'signUp' ? 12 : undefined}
            required
          />
        </label>
        {flow === 'signUp' && <p>Use at least 12 characters.</p>}
        <button className="button primary full-width" disabled={busy}>
          {busy
            ? 'Connecting…'
            : flow === 'signIn'
              ? 'Sign in'
              : 'Create account'}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
      <p className="modal-footnote">
        Pilot authentication: password recovery and email verification are not
        available yet.
      </p>
    </section>
  );
}
class PrivateBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <section className="workspace-card" role="alert">
        <h2>Workspace unavailable</h2>
        <p>
          Your session or case access may have changed. Sign out and sign in
          again to reconnect.
        </p>
      </section>
    ) : (
      this.props.children
    );
  }
}
