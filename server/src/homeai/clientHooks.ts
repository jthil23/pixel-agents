import type { OfficeBridge } from './officeBridge.js';

type Send = (m: Record<string, unknown>) => void;

export interface HomeAiClientHooks {
  readonly readingTools: string[];
  onClientReady(send: Send): void;
  handle(msg: Record<string, unknown>, send: Send): boolean;
}

/** omp/OpenClaw tool names drawn with the reading (not typing) animation. */
export const HOME_AI_READING_TOOLS = [
  'read',
  'grep',
  'glob',
  'find',
  'web_search',
  'web_fetch',
  'lsp',
  'recall',
  'ast_grep',
];

export function createHomeAiClientHooks(deps: {
  bridge: Pick<OfficeBridge, 'detail' | 'rootSessionId' | 'snapshotMessages'>;
  latest: () => Record<string, unknown>[];
  link: (sessionId: string) => Promise<{ url?: string; reason?: string }>;
}): HomeAiClientHooks {
  return {
    readingTools: HOME_AI_READING_TOOLS,
    onClientReady(send) {
      for (const m of deps.bridge.snapshotMessages()) send(m);
      for (const m of deps.latest()) send(m);
    },
    handle(msg, send) {
      if (msg.type === 'requestAgentDetail') {
        const detail = deps.bridge.detail(Number(msg.agentId));
        if (detail) send({ type: 'agentDetail', ...detail });
        return true;
      }
      if (msg.type === 'requestTranscriptLink') {
        const agentId = Number(msg.agentId);
        const sessionId = deps.bridge.rootSessionId(agentId);
        if (!sessionId) {
          send({ type: 'transcriptLink', agentId, reason: 'not an omp session' });
          return true;
        }
        void deps.link(sessionId).then((r) => send({ type: 'transcriptLink', agentId, ...r }));
        return true;
      }
      return false;
    },
  };
}
