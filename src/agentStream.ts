import { readResponseJson } from './responseJson';
import type { AgentActivityPhase, NormalizedTextBox } from './types';

export type LiveToolActivity = { toolName: string; phase: AgentActivityPhase; detail: string; status: 'active' | 'complete' | 'waiting' | 'error'; pageNumber?: number; viewport?: NormalizedTextBox };

export async function consumeAgentStream<T>(response: Response, onActivity: (event: LiveToolActivity) => void): Promise<{ payload: T; streamedActivityCount: number }> {
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    return { payload: await readResponseJson<T>(response), streamedActivityCount: 0 };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let payload: T | undefined;
  let streamError = '';
  let streamedActivityCount = 0;
  const dispatch = (frame: string) => {
    let eventName = 'message';
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    let value: any;
    try { value = JSON.parse(data.join('\n')); } catch { return; }
    if (eventName === 'activity' && typeof value.toolName === 'string' && typeof value.phase === 'string' && typeof value.detail === 'string') {
      streamedActivityCount += 1;
      onActivity(value as LiveToolActivity);
    } else if (eventName === 'result') payload = value as T;
    else if (eventName === 'error') streamError = typeof value.error === 'string' ? value.error : 'Agent stream failed.';
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n';
        buffer = buffer.slice(boundary + separator.length);
        dispatch(frame);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (done) break;
    }
    if (buffer.trim()) dispatch(buffer);
  } finally {
    reader.releaseLock();
  }
  if (streamError) throw new Error(streamError);
  if (payload === undefined) throw new Error('Agent stream ended without a result.');
  return { payload, streamedActivityCount };
}
