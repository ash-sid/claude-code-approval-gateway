import { useEffect, useState } from 'react';
import type { Approval, DecisionAction } from './types';
import { decide } from './api';

function useCountdown(expiresAt: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.round((expiresAt - now) / 1000));
}

const RISK_TONE: Record<string, string> = {
  sudo: 'bg-red-500/15 text-red-300 ring-red-500/30',
  'recursive-delete': 'bg-red-500/15 text-red-300 ring-red-500/30',
  'protected-path-delete': 'bg-red-500/15 text-red-300 ring-red-500/30',
  'disk-destroy': 'bg-red-500/15 text-red-300 ring-red-500/30',
  'remote-exec': 'bg-red-500/15 text-red-300 ring-red-500/30',
  'force-push': 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  'history-rewrite': 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  'secret-read': 'bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30',
  'secret-write': 'bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30',
};
const riskTone = (code: string) => RISK_TONE[code] ?? 'bg-amber-500/15 text-amber-300 ring-amber-500/30';

function commandOf(input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command;
  return JSON.stringify(input, null, 2);
}

export function ApprovalCard({ a }: { a: Approval }) {
  const remaining = useCountdown(a.expiresAt);
  const [altering, setAltering] = useState(false);
  const [draft, setDraft] = useState(commandOf(a.toolInput));
  const [busy, setBusy] = useState<DecisionAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isBash = typeof a.toolInput.command === 'string';

  async function run(action: DecisionAction, updatedInput?: Record<string, unknown>) {
    setBusy(action);
    setError(null);
    try {
      await decide(a.id, action, { updatedInput });
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  const nearExpiry = remaining <= 15;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 shadow-lg shadow-black/20 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-zinc-800 bg-zinc-900">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex h-2 w-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
          <span className="font-mono text-xs text-zinc-400 truncate">
            {a.toolName} · session {a.sessionId.slice(0, 8)}
          </span>
        </div>
        <span
          className={`font-mono text-xs tabular-nums px-2 py-0.5 rounded-md ring-1 ${
            nearExpiry ? 'text-red-300 ring-red-500/40 bg-red-500/10' : 'text-zinc-400 ring-zinc-700'
          }`}
          title="Time left before the held hook response times out"
        >
          {remaining}s
        </span>
      </div>

      <div className="px-4 py-3 space-y-3">
        <div className="text-xs text-zinc-500 font-mono truncate" title={a.cwd}>
          {a.cwd}
        </div>

        {!altering ? (
          <pre className="text-sm text-zinc-100 font-mono bg-black/40 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words ring-1 ring-zinc-800">
            {commandOf(a.toolInput)}
          </pre>
        ) : (
          <div className="space-y-2">
            <label className="text-xs text-zinc-400">
              {isBash ? 'Rewrite command' : 'Rewrite tool input (JSON)'}
            </label>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={isBash ? 3 : 6}
              spellCheck={false}
              className="w-full text-sm text-emerald-200 font-mono bg-black/50 rounded-lg p-3 ring-1 ring-emerald-500/30 focus:ring-emerald-500/60 outline-none resize-y"
            />
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {a.riskFactors.map((r, i) => (
            <span
              key={i}
              title={r.evidence ? `matched: ${r.evidence}` : undefined}
              className={`text-[11px] font-medium px-2 py-0.5 rounded-full ring-1 ${riskTone(r.code)}`}
            >
              {r.label}
            </span>
          ))}
        </div>

        {error && <div className="text-xs text-red-400 font-mono">{error}</div>}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-zinc-800 bg-zinc-950/50">
        {!altering ? (
          <>
            <button
              disabled={!!busy}
              onClick={() => run('approve')}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 transition"
            >
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </button>
            <button
              disabled={!!busy}
              onClick={() => run('deny')}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-zinc-700 hover:bg-zinc-600 text-zinc-100 disabled:opacity-50 transition"
            >
              Deny
            </button>
            <button
              disabled={!!busy}
              onClick={() => {
                setDraft(commandOf(a.toolInput));
                setAltering(true);
              }}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-amber-200 ring-1 ring-amber-500/30 disabled:opacity-50 transition"
            >
              Alter command
            </button>
            <button
              disabled={!!busy}
              onClick={() => run('stop')}
              title="Deny and stop the Claude session entirely (continue:false)"
              className="ml-auto px-3 py-1.5 rounded-lg text-sm font-medium bg-red-900/60 hover:bg-red-800 text-red-200 ring-1 ring-red-500/40 disabled:opacity-50 transition"
            >
              Stop session
            </button>
          </>
        ) : (
          <>
            <button
              disabled={!!busy}
              onClick={() => {
                const trimmed = draft.trim();
                let updatedInput: Record<string, unknown>;
                if (isBash) {
                  updatedInput = { ...a.toolInput, command: trimmed };
                } else {
                  try {
                    updatedInput = JSON.parse(trimmed);
                  } catch {
                    setError('Invalid JSON');
                    return;
                  }
                }
                run('alter', updatedInput);
              }}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 transition"
            >
              {busy === 'alter' ? 'Sending…' : 'Approve altered'}
            </button>
            <button
              disabled={!!busy}
              onClick={() => setAltering(false)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 disabled:opacity-50 transition"
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
