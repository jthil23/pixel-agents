export type StopReason = 'stop' | 'aborted' | 'error' | 'length';

export type SessionEvent =
  | { kind: 'header'; sessionId: string; cwd: string; at: string }
  | { kind: 'title'; title: string; at: string }
  | { kind: 'init'; agent: string; modelRole?: string; resolvedModel?: string; at: string }
  | {
      kind: 'toolStart';
      toolId: string;
      toolName: string;
      input: Record<string, unknown>;
      intent?: string;
      at: string;
    }
  | { kind: 'toolEnd'; toolId: string; toolName: string; isError: boolean; at: string }
  | { kind: 'userMessage'; at: string }
  | { kind: 'turnEnd'; stopReason: StopReason; at: string }
  | {
      kind: 'usage';
      model: string;
      costUsd: number;
      totalTokens: number;
      contextTokens: number;
      at: string;
    }
  | { kind: 'sessionExit'; at: string };

export type AgentSource = 'omp' | 'openclaw';
export type AgentRole = 'session' | 'subagent' | 'advisor' | 'openclaw';
export type MailroomKind = 'envelope' | 'phone' | 'clock';

export interface TrackedAgent {
  /** Absolute transcript path, or `openclaw:<agentId>`. */
  key: string;
  source: AgentSource;
  role: AgentRole;
  parentKey?: string;
  name: string;
  /** Drives Area seating (folder → Area mapping). */
  folderName: string;
  /** omp session id (root sessions only); used for transcript links. */
  sessionId?: string;
}

export interface SourceSink {
  upsertAgent(agent: TrackedAgent): void;
  applyEvents(key: string, events: SessionEvent[], replay: boolean): void;
  removeAgent(key: string): void;
  mailroom(key: string, kind: MailroomKind, phase: 'start' | 'end', failed: boolean): void;
}
