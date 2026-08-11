import { useEffect, useMemo, useRef, useState } from 'react';
import type { Approval } from './types';
import { fetchApprovals, streamApprovals } from './api';
import { ApprovalCard } from './ApprovalCard';

const STATUS_TONE: Record<string, string> = {
  approved: 'text-emerald-400',
  altered: 'text-emerald-400',
  denied: 'text-zinc-400',
  stopped: 'text-red-400',
  expired: 'text-red-400',
};

export default function App() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [connected, setConnected] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let closed = false;

    const startPolling = () => {
      if (pollRef.current) return;
      const tick = async () => {
        try {
          setApprovals(await fetchApprovals());
          setConnected(true);
        } catch {
          setConnected(false);
        }
      };
      tick();
      pollRef.current = setInterval(tick, 1500);
    };
    const stopPolling = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };

    const unsub = streamApprovals(
      (list) => {
        if (closed) return;
        setApprovals(list);
        setConnected(true);
        stopPolling(); // SSE is live; no need to poll
      },
      () => {
        if (closed) return;
        setConnected(false);
        startPolling(); // fall back to polling
      },
    );

    return () => {
      closed = true;
      unsub();
      stopPolling();
    };
  }, []);

  const pending = useMemo(() => approvals.filter((a) => a.status === 'pending'), [approvals]);
  const resolved = useMemo(
    () => approvals.filter((a) => a.status !== 'pending').slice(0, 25),
    [approvals],
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-amber-400 to-orange-600 flex items-center justify-center text-black font-bold text-sm">
              ⛨
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-tight">Permission Gateway</h1>
              <p className="text-[11px] text-zinc-500 leading-tight">Claude Code · PreToolUse</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-lg font-semibold tabular-nums leading-none">{pending.length}</div>
              <div className="text-[11px] text-zinc-500">pending</div>
            </div>
            <span
              className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full ring-1 ${
                connected
                  ? 'text-emerald-400 ring-emerald-500/30 bg-emerald-500/10'
                  : 'text-zinc-500 ring-zinc-700 bg-zinc-800/50'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-zinc-500'}`} />
              {connected ? 'live' : 'offline'}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-8">
        <section className="space-y-3">
          {pending.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 py-16 text-center">
              <p className="text-zinc-400 text-sm">No pending approvals.</p>
              <p className="text-zinc-600 text-xs mt-1">
                Dangerous tool calls from Claude Code will appear here for review.
              </p>
            </div>
          ) : (
            pending.map((a) => <ApprovalCard key={a.id} a={a} />)
          )}
        </section>

        {resolved.length > 0 && (
          <section>
            <h2 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Recent decisions</h2>
            <div className="rounded-xl border border-zinc-800 divide-y divide-zinc-800/70 overflow-hidden">
              {resolved.map((a) => (
                <div key={a.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span
                    className={`text-xs font-medium w-16 shrink-0 ${STATUS_TONE[a.status] ?? 'text-zinc-400'}`}
                  >
                    {a.status}
                  </span>
                  <span className="font-mono text-xs text-zinc-300 truncate flex-1">
                    {typeof a.toolInput.command === 'string'
                      ? a.toolInput.command
                      : `${a.toolName} ${JSON.stringify(a.toolInput)}`}
                  </span>
                  <span className="text-[11px] text-zinc-600 shrink-0">
                    {a.decidedAt ? new Date(a.decidedAt).toLocaleTimeString() : ''}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
