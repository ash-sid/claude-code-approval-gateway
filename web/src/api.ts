import type { Approval, DecisionAction } from './types';

export async function fetchApprovals(): Promise<Approval[]> {
  const r = await fetch('/api/approvals');
  const j = await r.json();
  return j.approvals as Approval[];
}

export async function decide(
  id: string,
  action: DecisionAction,
  opts: { updatedInput?: Record<string, unknown>; note?: string } = {},
): Promise<void> {
  const r = await fetch(`/api/approvals/${id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...opts }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error ?? `decide failed (${r.status})`);
  }
}

/**
 * Subscribe to the SSE stream of the full approval list. Returns an unsubscribe
 * fn. Calls onError so the caller can fall back to polling.
 */
export function streamApprovals(onData: (a: Approval[]) => void, onError: () => void): () => void {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    try {
      onData(JSON.parse(e.data) as Approval[]);
    } catch {
      /* ignore keep-alive pings */
    }
  };
  es.onerror = () => onError();
  return () => es.close();
}
