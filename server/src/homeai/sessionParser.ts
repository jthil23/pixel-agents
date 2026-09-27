import type { SessionEvent, StopReason } from './types.js';

type Rec = Record<string, unknown>;

const FINAL_STOP_REASONS: ReadonlySet<string> = new Set<StopReason>([
  'stop',
  'aborted',
  'error',
  'length',
]);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Rec =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {};

export interface SessionParser {
  parseLine(line: string): SessionEvent[];
}

export function createSessionParser(): SessionParser {
  /** Open tool id → tool name. */
  const open = new Map<string, string>();

  function startTool(
    toolId: string | undefined,
    toolName: string | undefined,
    input: unknown,
    intent: string | undefined,
    at: string,
  ): SessionEvent[] {
    if (!toolId || open.has(toolId)) return [];
    const name = toolName ?? 'tool';
    open.set(toolId, name);
    return [
      {
        kind: 'toolStart',
        toolId,
        toolName: name,
        input: obj(input),
        ...(intent ? { intent } : {}),
        at,
      },
    ];
  }

  function parseMessage(msg: Rec, at: string): SessionEvent[] {
    if (msg.role === 'toolResult') {
      const toolId = str(msg.toolCallId);
      if (!toolId) return [];
      const toolName = str(msg.toolName) ?? open.get(toolId) ?? 'tool';
      open.delete(toolId);
      return [{ kind: 'toolEnd', toolId, toolName, isError: msg.isError === true, at }];
    }
    if (msg.role === 'user') return [{ kind: 'userMessage', at }];
    if (msg.role !== 'assistant') return [];
    const out: SessionEvent[] = [];
    if (msg.usage && typeof msg.usage === 'object') {
      const u = obj(msg.usage);
      out.push({
        kind: 'usage',
        model: str(msg.model) ?? 'unknown',
        costUsd: num(obj(u.cost).total),
        totalTokens: num(u.totalTokens),
        contextTokens: num(u.input) + num(u.cacheRead) + num(u.cacheWrite),
        at,
      });
    }
    for (const raw of Array.isArray(msg.content) ? msg.content : []) {
      const block = obj(raw);
      if (block.type === 'toolCall')
        out.push(
          ...startTool(str(block.id), str(block.name), block.arguments, str(block.intent), at),
        );
    }
    const stop = str(msg.stopReason);
    if (stop && FINAL_STOP_REASONS.has(stop))
      out.push({ kind: 'turnEnd', stopReason: stop as StopReason, at });
    return out;
  }

  return {
    parseLine(line: string): SessionEvent[] {
      let rec: Rec;
      try {
        rec = obj(JSON.parse(line));
      } catch {
        return [];
      }
      const at = str(rec.timestamp) ?? '';
      switch (rec.type) {
        case 'session': {
          const header: SessionEvent = {
            kind: 'header',
            sessionId: str(rec.id) ?? '',
            cwd: str(rec.cwd) ?? '',
            at,
          };
          const title = str(rec.title);
          return title ? [header, { kind: 'title', title, at }] : [header];
        }
        case 'title':
        case 'title_change': {
          const title = str(rec.title);
          return title ? [{ kind: 'title', title, at }] : [];
        }
        case 'session_init': {
          const modelRole = str(rec.modelRole);
          const resolvedModel = str(rec.resolvedModel);
          return [
            {
              kind: 'init',
              agent: str(rec.agent) ?? 'task',
              ...(modelRole ? { modelRole } : {}),
              ...(resolvedModel ? { resolvedModel } : {}),
              at,
            },
          ];
        }
        case 'custom': {
          const data = obj(rec.data);
          if (rec.customType === 'tool_execution_start')
            return startTool(
              str(data.toolCallId),
              str(data.toolName),
              data.args,
              str(data.intent),
              at,
            );
          if (rec.customType === 'session_exit') return [{ kind: 'sessionExit', at }];
          return [];
        }
        case 'message':
          return parseMessage(obj(rec.message), at);
        default:
          return [];
      }
    },
  };
}
