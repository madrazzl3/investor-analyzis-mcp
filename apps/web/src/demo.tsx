import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

type Page = 'Overview' | 'Chat' | 'Documents' | 'Report';
type Modal = 'auth' | 'connect' | 'new' | null;
const findings = [
  {
    title: 'Revenue definitions need reconciliation',
    severity: 'High',
    category: 'Financial consistency',
    text: 'The deck presents $2.4M ARR. In the founder call, the same figure includes one-time implementation fees.',
    source: 'Pitch deck · slide 12',
    second: 'Founder call · 18:42',
    quote:
      '“Our annualized revenue is about $2.4 million, including implementation.”',
    question: 'What portion of the $2.4M is contracted recurring revenue?',
    slide: 'Annual recurring revenue',
    value: '$2.4M',
    confidence: 'Strong source support',
  },
  {
    title: 'Customer count uses two different definitions',
    severity: 'Medium',
    category: 'Cross-document review',
    text: 'The deck lists 42 customers, while the conversation distinguishes 28 paying accounts from 14 active pilots.',
    source: 'Pitch deck · slide 8',
    second: 'Founder call · 24:16',
    quote: '“Twenty-eight are paying today. Another fourteen are in pilot.”',
    question: 'Which pilots have signed contracts, and when do they convert?',
    slide: 'Customers building with us',
    value: '42',
    confidence: 'Strong source support',
  },
  {
    title: 'Enterprise launch timing is unconfirmed',
    severity: 'Low',
    category: 'Timeline review',
    text: 'The roadmap targets a Q3 launch; the call describes security review as a dependency without a completion date.',
    source: 'Pitch deck · slide 17',
    second: 'Founder call · 31:08',
    quote:
      '“We will set the launch date once the security review is complete.”',
    question: 'What remains in the security review, and who owns delivery?',
    slide: 'Enterprise launch',
    value: 'Q3',
    confidence: 'Additional evidence needed',
  },
];
const docs = [
  ['Northstar — Seed deck.pdf', 'Pitch deck', '22 slides', 'PDF'],
  ['Founder conversation.txt', 'Discussion transcript', '46 minutes', 'TXT'],
];
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    chat: (
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z" />
    ),
    file: (
      <>
        <path d="M14 2H5v20h14V7l-5-5Z" />
        <path d="M14 2v6h5M8 12h8M8 16h6" />
      </>
    ),
    report: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h4" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    link: (
      <>
        <path
          d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"
          transform="translate(0 1) scale(.92)"
        />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    shield: (
      <>
        <path d="m12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5l8-3Z" />
        <path d="m8 11 3 3 5-5" />
      </>
    ),
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.grid}
    </svg>
  );
}
export function Demo({ onWorkspace }: { onWorkspace: () => void }) {
  const [page, setPage] = useState<Page>('Overview');
  const [modal, setModal] = useState<Modal>(null);
  const [evidence, setEvidence] = useState<number | null>(null);
  const [client, setClient] = useState('ChatGPT');
  const [notice, setNotice] = useState('');
  const [answer, setAnswer] = useState('');
  const selected = evidence === null ? null : findings[evidence];
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!modal && evidence === null) return;
    const previous = document.activeElement as HTMLElement | null;
    const layer = document.querySelector<HTMLElement>('[role="dialog"]');
    const controls = () =>
      Array.from(
        layer?.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]') ||
          [],
      );
    controls()[0]?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setModal(null);
        setEvidence(null);
      }
      if (event.key === 'Tab') {
        const list = controls();
        const first = list[0];
        const last = list[list.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      previous?.focus();
    };
  }, [modal, evidence]);
  const ask = (text: string) => {
    setPage('Chat');
    setAnswer(text);
  };
  const nav: [Page, string][] = [
    ['Overview', 'grid'],
    ['Chat', 'chat'],
    ['Documents', 'file'],
    ['Report', 'report'],
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage('Overview');
          }}
        >
          <span className="brand-symbol">
            d<span>·</span>
          </span>
          diligent<span className="brand-period">.</span>
        </a>
        <div className="workspace-picker">
          <span className="workspace-icon">A</span>
          <div>
            <b>Atlas Ventures</b>
            <small>Fictional investment workspace</small>
          </div>
          <span className="muted">⌄</span>
        </div>
        <div className="side-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {nav.map(([label, icon]) => (
            <button
              key={label}
              className={`nav-item ${page === label ? 'active' : ''}`}
              onClick={() => setPage(label)}
            >
              <Icon name={icon} />
              {label}
              {label === 'Documents' && <span className="nav-count">2</span>}
            </button>
          ))}
        </nav>
        <div className="side-label case-label">
          YOUR CASES{' '}
          <button
            className="icon-button"
            aria-label="Create case"
            onClick={() => setModal('new')}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        <button className="case-nav" onClick={() => setPage('Overview')}>
          <span className="case-dot" />
          Northstar AI<span className="tiny-label">DEMO</span>
        </button>
        <button className="new-case" onClick={() => setModal('new')}>
          <Icon name="plus" size={15} /> New case
        </button>
        <div className="sidebar-bottom">
          <div className="connect-card">
            <span className="mini-icon">
              <Icon name="link" />
            </span>
            <h3>Your tools. Same evidence.</h3>
            <p>Take your diligence into the AI app you already use.</p>
            <button onClick={() => setModal('connect')}>
              Connect via MCP <Icon name="arrow" size={15} />
            </button>
          </div>
          <button className="profile" onClick={() => setModal('auth')}>
            <span className="avatar">JD</span>
            <span>
              <b>Demo visitor</b>
              <small>No account connected</small>
            </span>
            <Icon name="chevron" size={14} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            Cases <span>/</span> <b>Northstar AI</b>
          </div>
          <div className="top-actions">
            <div className="mode-switch" aria-label="Workspace mode">
              <button
                className="selected"
                onClick={() => {
                  setAnswer('');
                }}
              >
                Demo mode
              </button>
              <button className="" onClick={() => setModal('auth')}>
                My workspace
              </button>
            </div>
            <button className="signin" onClick={() => setModal('auth')}>
              Sign in <Icon name="arrow" size={14} />
            </button>
          </div>
        </header>
        <div className="demo-banner">
          <span>
            <span className="live-dot" /> You’re exploring a sample case{' '}
            <span className="banner-detail">
              — synthetic documents, illustrative findings. No live analysis.
            </span>
          </span>
          <span className="preview-tag">SYNTHETIC DEMO</span>
        </div>
        <main>
          <section className="case-heading">
            <div>
              <div className="eyebrow">
                <span className="company-mark">N</span> NORTHSTAR AI{' '}
                <span className="divider">/</span> SEED ROUND
              </div>
              <h1>
                {page === 'Overview'
                  ? 'Conviction starts with clarity.'
                  : page === 'Chat'
                    ? 'Ask better questions.'
                    : page === 'Documents'
                      ? 'Every claim has a source.'
                      : 'The diligence brief.'}
              </h1>
              <p>
                {page === 'Overview'
                  ? 'Your first look at the story, the evidence, and the questions worth asking.'
                  : page === 'Chat'
                    ? 'Explore the case with an assistant grounded in your documents.'
                    : page === 'Documents'
                      ? 'The materials behind this review, preserved and connected to each finding.'
                      : 'A clear view of what matters before your next founder conversation.'}
              </p>
            </div>
            <div className="heading-actions">
              <button
                className="button secondary"
                onClick={() => setModal('connect')}
              >
                <Icon name="link" /> Connect via MCP
              </button>
              <button
                className="button primary"
                onClick={() => setPage(page === 'Chat' ? 'Overview' : 'Chat')}
              >
                <Icon name="chat" />
                {page === 'Chat' ? 'Case overview' : 'Chat here'}
              </button>
            </div>
          </section>
          <div className="case-meta">
            <span>
              <span className="status-dot" /> Sample review ready
            </span>
            <span>
              <Icon name="file" size={14} /> 2 documents
            </span>
            <span>
              <Icon name="clock" size={14} /> Updated just now · demo
            </span>
            <span className="case-id">CASE NS–001</span>
          </div>
          {page === 'Overview' && (
            <>
              <section className="stats" aria-label="Review summary">
                <div>
                  <span>Issues to explore</span>
                  <strong>
                    03 <small>across 2 sources</small>
                  </strong>
                  <div className="stat-bars">
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
                <div>
                  <span>Highest priority</span>
                  <strong className="high-stat">
                    High <span className="severity high">1 finding</span>
                  </strong>
                  <small>Revenue definition discrepancy</small>
                </div>
                <div>
                  <span>Evidence coverage</span>
                  <strong>
                    22 <small>slides in sample deck</small>
                  </strong>
                  <small>Plus a 46-minute founder conversation</small>
                </div>
                <div>
                  <span>Next step</span>
                  <strong className="next-stat">
                    Founder follow-up <Icon name="arrow" />
                  </strong>
                  <button
                    className="text-button"
                    onClick={() => ask('What should I ask the founders?')}
                  >
                    See suggested questions
                  </button>
                </div>
              </section>
              <div className="content-grid">
                <section>
                  <div className="section-heading">
                    <div>
                      <h2>
                        What deserves a closer look{' '}
                        <span className="counter">3</span>
                      </h2>
                      <p>Potential issues, with the context to judge them.</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setPage('Report')}
                    >
                      Full report <Icon name="arrow" size={15} />
                    </button>
                  </div>
                  <div className="findings">
                    {findings.map((f, i) => (
                      <button
                        className="finding"
                        key={f.title}
                        onClick={() => setEvidence(i)}
                      >
                        <div className="finding-top">
                          <span
                            className={`severity ${f.severity.toLowerCase()}`}
                          >
                            {f.severity}
                          </span>
                          <span className="category">{f.category}</span>
                          <span className="finding-number">0{i + 1}</span>
                        </div>
                        <h3>{f.title}</h3>
                        <p>{f.text}</p>
                        <div className="finding-footer">
                          <span>
                            <Icon name="file" size={13} />
                            {f.source}
                          </span>
                          <span>
                            View evidence <Icon name="arrow" size={14} />
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
                <aside className="right-column">
                  <div className="pipeline-card">
                    <div className="section-heading">
                      <h2>A second set of eyes</h2>
                      <Icon name="spark" />
                    </div>
                    <p>
                      Specialists review independently.
                      <br />
                      Every finding returns to the evidence.
                    </p>
                    <div className="pipeline">
                      {[
                        ['Document review', 'Claims & source references'],
                        [
                          'Financial consistency',
                          'Numbers & metric definitions',
                        ],
                        [
                          'Cross-document review',
                          'Contradictions & missing context',
                        ],
                        [
                          'Evidence verification',
                          'Alternative explanations checked',
                        ],
                      ].map(([title, detail]) => (
                        <div className="pipeline-step" key={title}>
                          <span>
                            <Icon name="check" size={13} />
                          </span>
                          <div>
                            <b>{title}</b>
                            <small>{detail}</small>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="pipeline-note">
                      Illustrative workflow · precomputed sample
                    </div>
                  </div>
                  <div className="question-card">
                    <span className="eyebrow">THE NEXT CONVERSATION</span>
                    <h3>“What portion of ARR is actually recurring?”</h3>
                    <p>A good question is often more useful than a red flag.</p>
                    <button
                      className="text-button"
                      onClick={() => ask('What should I ask the founders?')}
                    >
                      Prepare my questions <Icon name="arrow" size={15} />
                    </button>
                  </div>
                  <div className="privacy-note">
                    <Icon name="shield" size={18} />
                    <span>
                      Evidence first. Findings are questions to investigate, not
                      conclusions of misconduct.
                    </span>
                  </div>
                </aside>
              </div>
            </>
          )}
          {page === 'Chat' && (
            <div className="chat-layout">
              <section className="chat-panel">
                <div className="chat-header">
                  <span className="assistant-mark">
                    <Icon name="spark" />
                  </span>
                  <div>
                    <b>Your diligence partner</b>
                    <small>Grounded in Northstar AI’s sample materials</small>
                  </div>
                  <span className="tiny-label">DEMO</span>
                </div>
                <div className="messages">
                  <div className="message assistant">
                    <span className="message-label">DILIGENT</span>
                    <h2>Let’s look beyond the pitch.</h2>
                    <p>
                      I’ve organized this sample case around three questions:
                      recurring revenue, paying customers, and the enterprise
                      launch timeline.
                    </p>
                    <p>Where would you like to start?</p>
                    <div className="suggestions">
                      {[
                        'Summarize the biggest risks',
                        'What should I ask the founders?',
                        'Show the revenue evidence',
                      ].map((q) => (
                        <button key={q} onClick={() => ask(q)}>
                          {q}
                          <Icon name="arrow" size={14} />
                        </button>
                      ))}
                    </div>
                  </div>
                  {answer && (
                    <>
                      <div className="message user-message">{answer}</div>
                      <div className="message assistant">
                        <span className="message-label">
                          PREWRITTEN DEMO RESPONSE
                        </span>
                        <p>
                          The most important follow-up is how Northstar defines
                          recurring revenue. The deck cites <b>$2.4M ARR</b>,
                          while the founder includes implementation fees in the
                          annualized figure.
                        </p>
                        <blockquote>
                          Ask for a bridge from total annualized revenue to
                          contracted recurring revenue, with one-time fees shown
                          separately.
                        </blockquote>
                        <p>
                          This may be a definition difference. It needs
                          clarification before being treated as a misstatement.
                        </p>
                        <button
                          className="source-chip"
                          onClick={() => setEvidence(0)}
                        >
                          <Icon name="file" size={14} /> Slide 12 + founder call
                          18:42 <Icon name="arrow" size={14} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
                <div className="composer">
                  <small>
                    Choose a suggested question above. Demo responses are
                    prewritten; private questions and files are not accepted.
                  </small>
                </div>
              </section>
              <aside className="chat-context">
                <span className="eyebrow">CASE CONTEXT</span>
                <h2>Northstar AI</h2>
                <p>
                  AI operations platform
                  <br />
                  Seed · $3M raise · B2B SaaS
                </p>
                <hr />
                <h3>Sources in this conversation</h3>
                {docs.map((d) => (
                  <button
                    className="context-doc"
                    key={d[0]}
                    onClick={() => setPage('Documents')}
                  >
                    <Icon name="file" />
                    <span>
                      {d[0]}
                      <small>{d[2]}</small>
                    </span>
                  </button>
                ))}
                <hr />
                <h3>Keep the evidence close</h3>
                <p>
                  Every material finding should lead back to an original source.
                </p>
                <button
                  className="button secondary"
                  onClick={() => setPage('Report')}
                >
                  Open sample report <Icon name="arrow" size={15} />
                </button>
              </aside>
            </div>
          )}
          {page === 'Documents' && (
            <section className="documents-panel">
              <div className="section-heading">
                <div>
                  <h2>Case materials</h2>
                  <p>Two synthetic documents used throughout this demo.</p>
                </div>
                <button
                  className="button secondary"
                  onClick={() => setModal('new')}
                >
                  <Icon name="upload" /> Add documents
                </button>
              </div>
              <div className="document-table">
                <div className="document-table-head">
                  <span>DOCUMENT</span>
                  <span>TYPE</span>
                  <span>STATUS</span>
                  <span />
                </div>
                {docs.map((d, i) => (
                  <button
                    className="document-row"
                    key={d[0]}
                    onClick={() => setEvidence(i)}
                  >
                    <span>
                      <span className={`file-tile ${i ? 'txt' : ''}`}>
                        {d[3]}
                      </span>
                      <span>
                        <b>{d[0]}</b>
                        <small>{d[2]} · sample material</small>
                      </span>
                    </span>
                    <span>{d[1]}</span>
                    <span className="ready">
                      <Icon name="check" size={14} /> Sample ready
                    </span>
                    <Icon name="chevron" size={16} />
                  </button>
                ))}
              </div>
              <button className="upload-zone" onClick={() => setModal('new')}>
                <Icon name="upload" size={28} />
                <h3>Bring the full story together.</h3>
                <p>Pitch decks and founder conversations, in one case.</p>
                <span className="button secondary">Preview upload flow</span>
                <small>No files are uploaded in this mockup.</small>
              </button>
            </section>
          )}
          {page === 'Report' && (
            <section className="report-layout">
              <div className="report-paper">
                <div className="report-kicker">
                  <span>DILIGENT / INVESTMENT REVIEW</span>
                  <span>ILLUSTRATIVE SAMPLE</span>
                </div>
                <h2>Northstar AI</h2>
                <p className="report-subtitle">
                  Preliminary diligence brief · Seed round
                </p>
                <div className="report-summary">
                  <span className="eyebrow">EXECUTIVE PERSPECTIVE</span>
                  <h3>
                    A promising story.
                    <br />
                    Three definitions to get clear.
                  </h3>
                  <p>
                    The sample materials describe an early B2B platform with
                    paying customers and an enterprise roadmap. The next
                    conversation should reconcile recurring revenue, distinguish
                    paid accounts from pilots, and establish launch
                    dependencies.
                  </p>
                </div>
                <h3 className="report-section-title">Priority follow-ups</h3>
                {findings.map((f, i) => (
                  <div className="report-finding" key={f.title}>
                    <span className="report-index">0{i + 1}</span>
                    <div>
                      <span className={`severity ${f.severity.toLowerCase()}`}>
                        {f.severity}
                      </span>
                      <h3>{f.title}</h3>
                      <p>{f.question}</p>
                      <button
                        className="text-button"
                        onClick={() => setEvidence(i)}
                      >
                        Inspect source evidence <Icon name="arrow" size={14} />
                      </button>
                    </div>
                  </div>
                ))}
                <div className="report-disclaimer">
                  <Icon name="shield" />
                  <p>
                    This sample is based on fictional materials. A real review
                    would disclose extraction gaps and unresolved evidence.
                    Findings do not establish misconduct.
                  </p>
                </div>
              </div>
              <aside className="report-side">
                <h2>Ready for the next meeting</h2>
                <p>Keep the brief and its source material together.</p>
                <button
                  className="button primary"
                  onClick={() => ask('What should I ask the founders?')}
                >
                  <Icon name="chat" /> Discuss this report
                </button>
                <button
                  className="button secondary"
                  onClick={() =>
                    setNotice(
                      'Export is a layout placeholder. No report was downloaded.',
                    )
                  }
                >
                  <Icon name="report" /> Export report
                </button>
                <div className="report-tally">
                  <span>
                    High priority <b>1</b>
                  </span>
                  <span>
                    Medium priority <b>1</b>
                  </span>
                  <span>
                    Low priority <b>1</b>
                  </span>
                </div>
                <small>Example report · not an investment recommendation</small>
              </aside>
            </section>
          )}
          <footer className="page-footer">
            <span>
              diligent. <span>More context. Better questions.</span>
            </span>
            <span>Fictional company · presentation prototype</span>
          </footer>
        </main>
      </div>
      {modal && (
        <div className="overlay" onClick={() => setModal(null)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close dialog"
              onClick={() => setModal(null)}
            >
              <Icon name="close" />
            </button>
            {modal === 'auth' && (
              <>
                <span className="eyebrow">YOUR INVESTMENT WORKSPACE</span>
                <h2 id="modal-title">Your cases, securely connected.</h2>
                <p>
                  Sign in to access your organization’s cases and saved
                  analyses.
                </p>
                <button
                  className="button primary full-width"
                  onClick={onWorkspace}
                >
                  Open my workspace <Icon name="arrow" />
                </button>
                <p className="modal-footnote">
                  Sample conversations and findings stay in demo mode.
                </p>
              </>
            )}
            {modal === 'connect' && (
              <>
                <span className="modal-symbol">
                  <Icon name="link" size={25} />
                </span>
                <span className="eyebrow">WORK WHERE YOU THINK</span>
                <h2 id="modal-title">
                  Your preferred AI.
                  <br />
                  The same case.
                </h2>
                <p>Explore the proposed MCP connection experience.</p>
                <div className="client-picker">
                  {['ChatGPT', 'Claude', 'Grok'].map((c) => (
                    <button
                      className={client === c ? 'selected' : ''}
                      key={c}
                      onClick={() => setClient(c)}
                    >
                      <span>
                        {c === 'ChatGPT' ? '◎' : c === 'Claude' ? '✳' : '𝕏'}
                      </span>
                      {c}
                    </button>
                  ))}
                </div>
                <div className="connect-steps">
                  <span className="tiny-label">
                    {client.toUpperCase()} · PLANNED FLOW
                  </span>
                  <p>
                    <b>1</b> Add the hosted MCP connection in your client.
                  </p>
                  <p>
                    <b>2</b> Sign in and authorize access to your workspace.
                  </p>
                  <p>
                    <b>3</b> Ask about a case. Install the companion skill where
                    supported.
                  </p>
                </div>
                <div className="endpoint">
                  https://api.example.com/mcp <span>EXAMPLE</span>
                </div>
                <p className="modal-footnote">
                  No connection is made. Client setup and compatibility still
                  need verification.
                </p>
              </>
            )}
            {modal === 'new' && (
              <>
                <span className="modal-symbol">
                  <Icon name="plus" size={25} />
                </span>
                <span className="eyebrow">START WITH THE MATERIALS</span>
                <h2 id="modal-title">A new perspective starts here.</h2>
                <p>
                  Create a case, add the deck and conversation, then ask your
                  first question.
                </p>
                <label className="auth-label">
                  Company name
                  <input value="Northstar AI" readOnly />
                </label>
                <div className="modal-upload">
                  <Icon name="upload" size={25} />
                  <h3>Pitch deck + discussion transcript</h3>
                  <p>PDF and TXT · upload area preview</p>
                </div>
                <button
                  className="button primary full-width"
                  onClick={() => {
                    setModal(null);
                    setPage('Documents');
                    setNotice(
                      'Showing the sample case. No files were uploaded or case created.',
                    );
                  }}
                >
                  Explore sample materials <Icon name="arrow" />
                </button>
                <p className="modal-footnote">
                  Layout only. Uploads and case creation are not connected.
                </p>
              </>
            )}
          </section>
        </div>
      )}
      {selected && (
        <div
          className="overlay evidence-overlay"
          onClick={() => setEvidence(null)}
        >
          <section
            className="evidence-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="evidence-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-top">
              <span className="eyebrow">FOLLOW THE EVIDENCE</span>
              <button
                className="icon-button"
                aria-label="Close evidence"
                onClick={() => setEvidence(null)}
              >
                <Icon name="close" />
              </button>
            </div>
            <span className={`severity ${selected.severity.toLowerCase()}`}>
              {selected.severity} priority
            </span>
            <h2 id="evidence-title">{selected.title}</h2>
            <p>{selected.text}</p>
            <div className="evidence-strength">
              <Icon name="shield" size={16} />
              {selected.confidence}
              <span>Sample</span>
            </div>
            <div className="source-label">
              <Icon name="file" size={15} />
              {selected.source}
            </div>
            <div className="slide-preview">
              <span>NORTHSTAR / SEED</span>
              <h3>{selected.slide}</h3>
              <strong>{selected.value}</strong>
              <div className="slide-line" />
              <small>
                Reconstructed fictional slide · not an uploaded document
              </small>
            </div>
            <div className="source-label">
              <Icon name="chat" size={15} />
              {selected.second}
            </div>
            <blockquote className="evidence-quote">
              {selected.quote}
              <cite>Founder · synthetic transcript</cite>
            </blockquote>
            <div className="followup">
              <span className="eyebrow">ASK THE FOUNDER</span>
              <p>{selected.question}</p>
            </div>
            <button
              className="button primary full-width"
              onClick={() => {
                ask(selected.question);
                setEvidence(null);
              }}
            >
              Discuss this finding <Icon name="arrow" />
            </button>
          </section>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <Icon name="spark" />
          {notice}
        </div>
      )}
    </div>
  );
}
