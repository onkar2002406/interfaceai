/**
 * The control panel shell.
 *
 * Holds the things every pane needs — the catalog, which tenant and identity are
 * selected, the open escalation — and nothing else. State that belongs to one
 * pane stays in that pane.
 *
 * The capability rail is always visible because it is the spine of the system:
 * every other pane is a way of looking at, exercising or producing one of those
 * artifacts.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, type Catalog, type CapabilityCard, type RunSummary } from './lib/api';
import { Chat, type ChatEscalation } from './panes/Chat';
import { Discover } from './panes/Discover';
import { Replay } from './panes/Replay';
import { Evidence } from './panes/Evidence';
import { Guardrails } from './panes/Guardrails';
import { AgentView } from './panes/AgentView';
import { Runs } from './panes/Runs';
import { EscalationModal } from './components/EscalationModal';

type TabId = 'chat' | 'replay' | 'discover' | 'runs' | 'evidence' | 'guardrails' | 'agent';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'replay', label: 'Replay' },
  { id: 'discover', label: 'Discover' },
  { id: 'runs', label: 'Run history' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'guardrails', label: 'Guardrails' },
  { id: 'agent', label: 'Agent view' },
];

export function App(): JSX.Element {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<TabId>('chat');
  const [selected, setSelected] = useState<CapabilityCard | null>(null);
  const [tenant, setTenant] = useState('');
  const [identity, setIdentity] = useState('');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [pending, setPending] = useState(0);
  const [health, setHealth] = useState<{ allUp: boolean; selfHosted: boolean; label: string } | null>(null);
  const [escalation, setEscalation] = useState<ChatEscalation | null>(null);
  const [evidenceDir, setEvidenceDir] = useState<string | null>(null);

  const loadCatalog = useCallback(async (): Promise<void> => {
    try {
      const c = await api.catalog();
      setCatalog(c);
      setTenant((t) => t || c.defaultTenant);
      setSelected((s) => {
        if (s) return c.capabilities.find((x) => x.name === s.name) ?? s;
        // Open on something a caller would actually invoke: an approved
        // capability if one exists, rather than whichever draft sorts first.
        return c.capabilities.find((x) => x.approval === 'approved') ?? c.capabilities[0] ?? null;
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadRuns = useCallback(async (): Promise<void> => {
    try {
      const r = await api.runs();
      setRuns(r.runs);
    } catch {
      /* the panel is still up; a stale list is not worth an error banner */
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
    void loadRuns();
  }, [loadCatalog, loadRuns]);

  // Open interventions, for the header badge. The run's own event stream is
  // timelier and is what actually opens the modal; this covers what that stream
  // cannot — a run started before the page was opened, or a reload while a
  // session sits parked.
  useEffect(() => {
    const check = async (): Promise<void> => {
      try {
        const r = await api.interventions();
        setPending(r.open.length);
      } catch {
        /* ignore */
      }
    };
    void check();
    const h = setInterval(() => void check(), 5000);
    return () => clearInterval(h);
  }, []);

  useEffect(() => {
    const check = async (): Promise<void> => {
      try {
        const h = await api.health();
        setHealth({
          allUp: h.allUp,
          selfHosted: h.selfHosted,
          label: h.allUp ? 'target reachable' : `target unreachable: ${h.tenants.filter((t) => !t.up).map((t) => t.label).join(', ')}`,
        });
      } catch {
        setHealth(null);
      }
    };
    void check();
    const h = setInterval(() => void check(), 15000);
    return () => clearInterval(h);
  }, []);

  if (loadError) {
    return (
      <div style={{ padding: '3rem' }}>
        <h1>Could not load the catalog</h1>
        <pre>{loadError}</pre>
        <p className="hint">
          The panel process may not be running, or it may be older than this bundle. The legacy page
          is at <a href="/legacy">/legacy</a>.
        </p>
      </div>
    );
  }

  if (!catalog) return <p style={{ padding: '2rem' }} className="hint">Loading…</p>;

  const openEvidence = (dir: string): void => {
    setEvidenceDir(dir);
    setTab('evidence');
  };

  return (
    <>
      <header className="top">
        <h1>Automation Control Panel</h1>
        <span className="tag mono">{catalog.product}</span>
        <span className="spacer" />
        {health && <span className={`badge ${health.allUp ? 'good' : 'bad'}`}>{health.label}</span>}
        {pending > 0 && (
          <span className="badge warn">
            {pending} intervention{pending === 1 ? '' : 's'} waiting
          </span>
        )}
        <a href={catalog.operatorUrl} target="_blank" rel="noopener noreferrer">
          Operator console ↗
        </a>
        <a href="/legacy">Legacy panel</a>
      </header>

      <div className="layout">
        <aside className="rail">
          {/* Above the capability list, not below it. Which operator is signed on
              is what makes a SUPERVISOR_OVERRIDE_REQUIRED result interpretable
              rather than mysterious, and it applies to chat as much as to a
              replay — burying it under seven cards makes it something you find
              after the run that needed it. */}
          <h2>Run as</h2>
          <label htmlFor="tenant">Tenant</label>
          <select id="tenant" value={tenant} onChange={(e) => setTenant(e.target.value)}>
            {catalog.tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <p className="hint">
            {(() => {
              const t = catalog.tenants.find((x) => x.id === tenant);
              return t ? `${t.baseUrl} · signs on via ${t.credentialEnv.user}` : '';
            })()}
          </p>

          {catalog.identities.length > 0 && (
            <>
              <label htmlFor="identity">Identity</label>
              <select id="identity" value={identity} onChange={(e) => setIdentity(e.target.value)}>
                <option value="">(profile default)</option>
                {catalog.identities.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.id}
                  </option>
                ))}
              </select>
              <p className="hint">
                {identity
                  ? `signs on via ${catalog.identities.find((i) => i.id === identity)?.credentialEnv.user} — the value never leaves .env`
                  : 'Entitlement-gated flows answer differently depending on who is signed on.'}
              </p>
            </>
          )}

          <h2 className="sec">Capabilities</h2>
          {catalog.error && <p className="hint">{catalog.error}</p>}
          {catalog.capabilities.length === 0 && (
            <p className="hint">
              None recorded for <span className="mono">{catalog.product}</span> yet. Use Discover, or
              ask for something in Chat.
            </p>
          )}
          {catalog.capabilities.map((c) => (
            <div
              key={`${c.name}@${c.version}`}
              className={`card clickable${selected?.name === c.name ? ' sel' : ''}`}
              onClick={() => {
                setSelected(c);
                if (tab !== 'replay') setTab('replay');
              }}
            >
              <h3>{c.name}</h3>
              <div>
                <span className="tag">v{c.version}</span>
                {c.hasIrreversibleStep ? (
                  <span className="tag risk">irreversible step</span>
                ) : (
                  <span className="tag safe">read-only</span>
                )}
                <span className={`tag ${c.approval === 'approved' ? 'safe' : 'draft'}`}>{c.approval}</span>
              </div>
              <p className="why">{c.title}</p>
              {c.approval === 'draft' && (
                <button
                  className="mini"
                  style={{ marginTop: '.4rem' }}
                  onClick={async (e) => {
                    e.stopPropagation();
                    await api.approve(`${c.name}@${c.version}`, true);
                    await loadCatalog();
                  }}
                >
                  Approve
                </button>
              )}
            </div>
          ))}

        </aside>

        <main className="main">
          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
                {t.label}
                {t.id === 'runs' && runs.some((r) => r.state === 'running') ? ' •' : ''}
              </button>
            ))}
          </nav>

          {tab === 'chat' && (
            <Chat
              catalog={catalog}
              tenant={tenant}
              identity={identity}
              onOpenEscalation={setEscalation}
              onRunsChanged={() => void loadRuns()}
            />
          )}
          {tab === 'replay' && (
            <Replay
              catalog={catalog}
              selected={selected}
              tenant={tenant}
              identity={identity}
              onOpenEscalation={setEscalation}
              onOpenEvidence={openEvidence}
              onRunsChanged={() => void loadRuns()}
            />
          )}
          {tab === 'discover' && (
            <Discover
              catalog={catalog}
              tenant={tenant}
              onRunsChanged={() => void loadRuns()}
              onCatalogChanged={() => void loadCatalog()}
            />
          )}
          {tab === 'runs' && <Runs runs={runs} onOpenEvidence={openEvidence} />}
          {tab === 'evidence' && <Evidence openDir={evidenceDir} onOpened={() => setEvidenceDir(null)} />}
          {tab === 'guardrails' && <Guardrails />}
          {tab === 'agent' && <AgentView operatorUrl={catalog.operatorUrl} />}
        </main>
      </div>

      {escalation && (
        <EscalationModal
          interventionId={escalation.interventionId}
          reason={escalation.reason}
          resumeContract={escalation.resumeContract}
          operatorUrl={catalog.operatorUrl}
          onClose={() => {
            setEscalation(null);
            void loadRuns();
          }}
        />
      )}
    </>
  );
}
