// webview-ui/src/homeai/HomeAiPanel.tsx
import { useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { transcriptButtonEnabled } from './homeAiSelectors.js';
import type { MonitorState } from './homeAiState.js';
import { closePanel, requestTranscript, useHomeAi } from './homeAiStore.js';
import { isMuted, setMuted } from './sound.js';

/* eslint-disable pixel-agents/no-inline-colors -- Colors encode Home-AI status and heartbeat states. */
const STATE_COLOR: Record<MonitorState, string> = {
  up: '#39ff14',
  flapping: '#ffb300',
  pending: '#ffb300',
  maintenance: '#40c4ff',
  down: '#ff3b30',
  unknown: '#6b6b6b',
};
const BEAT_COLOR = ['#ff3b30', '#39ff14', '#ffb300', '#40c4ff'];

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 44,
  right: 8,
  width: 450,
  maxWidth: 'calc(100vw - 32px)',
  maxHeight: 'calc(100% - 60px)',
  overflowY: 'auto',
  background: 'rgba(21,16,32,0.94)',
  border: '3px solid #3a2f55',
  color: '#eee',
  padding: 16,
  zIndex: 50,
  fontSize: 'var(--text-sm)',
  lineHeight: 1.5,
};

export function HomeAiPanel() {
  const s = useHomeAi();
  const [muted, setMutedState] = useState(isMuted);
  if (!s.active) return null;

  const toggleMute = () => {
    setMuted(!muted);
    setMutedState(!muted);
  };

  let body: React.ReactNode = null;
  if (s.panel?.kind === 'agent') {
    const id = s.panel.agentId;
    const d = s.details.get(id);
    const link = s.links.get(id);
    const transcriptEnabled = d
      ? transcriptButtonEnabled(d.canOpenTranscript, link?.reason)
      : false;
    body = d ? (
      <>
        <h3 style={{ margin: '0 0 6px', fontSize: 'var(--text-lg)', lineHeight: 1.25 }}>
          {d.title}
        </h3>
        <div>{`${d.role} · ${d.source}`}</div>
        <div>{d.model || 'model: —'}</div>
        <div>{`$${d.costUsd.toFixed(2)} · ${(d.contextTokens / 1000).toFixed(1)}k ctx`}</div>
        <ul style={{ paddingLeft: 24, margin: '12px 0' }}>
          {d.recentTools.map((t, i) => (
            <li key={i} style={{ color: t.isError ? '#ff8a80' : t.done ? '#bbb' : '#fff' }}>
              {`${t.done ? (t.isError ? '✗' : '✓') : '…'} ${t.status}`}
            </li>
          ))}
        </ul>
        <Button
          size="sm"
          variant={transcriptEnabled ? 'accent' : 'disabled'}
          disabled={!transcriptEnabled}
          onClick={() => requestTranscript(id)}
        >
          Open live transcript
        </Button>
        {link?.reason && <div style={{ color: '#ffb300', marginTop: 6 }}>{link.reason}</div>}
      </>
    ) : (
      <div>Loading…</div>
    );
  } else if (s.panel?.kind === 'cabinet') {
    const name = s.panel.groupName;
    const group = s.sol.groups.find((g) => g.name === name);
    body = (
      <>
        <h3 style={{ margin: '0 0 9px', fontSize: 'var(--text-lg)', lineHeight: 1.25 }}>
          {`${name}${s.sol.reachable ? '' : ' (no signal)'}`}
        </h3>
        {(group?.monitors ?? []).map((m) => (
          <div key={m.id} style={{ marginBottom: 9 }}>
            <span style={{ color: STATE_COLOR[m.state] }}>■ </span>
            {`${m.name} · ${m.state}${m.beats.length && m.beats[m.beats.length - 1].ping !== null ? ` · ${m.beats[m.beats.length - 1].ping} ms` : ''}`}
            <div style={{ display: 'flex', gap: 2, marginTop: 3 }}>
              {m.beats.map((b, i) => (
                <span
                  key={i}
                  title={`${b.time} UTC`}
                  style={{
                    width: 9,
                    height: 12,
                    background: BEAT_COLOR[b.status] ?? '#6b6b6b',
                    display: 'inline-block',
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </>
    );
  }

  return (
    <>
      <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 51 }}>
        <Button size="sm" onClick={toggleMute}>
          {muted ? 'Sound: off' : 'Sound: on'}
        </Button>
      </div>
      {s.panel && (
        <aside style={panelStyle}>
          <div style={{ textAlign: 'right' }}>
            <Button size="sm" variant="ghost" onClick={closePanel}>
              Close
            </Button>
          </div>
          {body}
        </aside>
      )}
    </>
  );
}
/* eslint-enable pixel-agents/no-inline-colors */
