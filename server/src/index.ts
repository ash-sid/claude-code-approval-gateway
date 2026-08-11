import express, { type Request, type Response } from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './policy.config.js';
import { evaluate } from './policy.js';
import { approvals, type ResolvedDecision } from './approvals.js';
import type { HookInput, HookOutput, DecisionRequest } from './types.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Build the exact hook JSON response for a resolved/immediate decision. */
function hookAllow(reason: string, updatedInput?: Record<string, unknown>): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
      ...(updatedInput ? { updatedInput } : {}),
    },
  };
}
function hookDeny(reason: string): HookOutput {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  };
}
function hookAsk(reason: string): HookOutput {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
  };
}
function hookStop(reason: string): HookOutput {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    continue: false,
    stopReason: reason,
  };
}

// ---------------------------------------------------------------------------
// The hook endpoint. Claude Code POSTs the PreToolUse payload here.
// ---------------------------------------------------------------------------
app.post('/pre-tool-use', async (req: Request, res: Response) => {
  const input = req.body as HookInput;
  if (!input || input.hook_event_name !== 'PreToolUse' || !input.tool_name) {
    return res.status(400).json(hookAsk('Malformed hook payload; falling back to prompt'));
  }

  const verdict = evaluate(input);
  const label = summarize(input);

  if (verdict.kind === 'allow') {
    console.log(`[allow] ${label}  (${verdict.matchedRule})`);
    return res.json(hookAllow(verdict.reason));
  }
  if (verdict.kind === 'ask') {
    console.log(`[ask]   ${label}`);
    return res.json(hookAsk(verdict.reason));
  }

  // Dangerous -> hold the response open until a human decides or it expires.
  console.log(`[HOLD]  ${label}  risks=[${verdict.riskFactors.map((r) => r.code).join(', ')}]`);

  let settled = false;
  const respondOnce = (payload: HookOutput) => {
    if (settled) return;
    settled = true;
    res.json(payload);
  };

  const { record, decided } = approvals.create({
    sessionId: input.session_id,
    cwd: input.cwd,
    toolName: input.tool_name,
    toolInput: input.tool_input,
    reason: verdict.reason,
    matchedRule: verdict.matchedRule,
    riskFactors: verdict.riskFactors,
    timeoutMs: config.approvalTimeoutMs,
    onExpire: () => {
      console.log(`[expire] ${record.id} -> ${config.onExpire}`);
    },
  });

  // If Claude Code drops the connection (its own hook timeout), stop waiting.
  // NOTE: watch `res` not `req` — express.json() fully consumes the request
  // stream, so `req` emits 'close' immediately; `res` 'close' means the client
  // actually went away (or we already responded, in which case `settled` guards).
  res.on('close', () => {
    if (!settled) {
      settled = true;
      console.log(`[closed] client disconnected before decision: ${record.id}`);
    }
  });

  const outcome: ResolvedDecision = await decided;

  switch (outcome.status) {
    case 'approved':
      return respondOnce(hookAllow(noteReason('Approved via gateway', outcome.note)));
    case 'altered':
      return respondOnce(
        hookAllow(noteReason('Command altered & approved via gateway', outcome.note), outcome.updatedInput),
      );
    case 'denied':
      return respondOnce(hookDeny(noteReason('Denied via gateway', outcome.note)));
    case 'stopped':
      return respondOnce(hookStop(noteReason('Session stopped via gateway', outcome.note)));
    case 'expired':
      return respondOnce(
        config.onExpire === 'ask'
          ? hookAsk('Approval timed out; falling back to native prompt')
          : hookDeny('Approval timed out with no decision (fail-closed)'),
      );
  }
});

// ---------------------------------------------------------------------------
// Dashboard API
// ---------------------------------------------------------------------------
app.get('/api/approvals', (_req, res) => {
  res.json({ approvals: approvals.list() });
});

app.post('/api/approvals/:id/decide', (req, res) => {
  const { action, updatedInput, note } = (req.body ?? {}) as DecisionRequest;
  const rec = approvals.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'not found' });
  if (rec.status !== 'pending') return res.status(409).json({ error: `already ${rec.status}` });

  let ok = false;
  switch (action) {
    case 'approve':
      ok = approvals.resolve(rec.id, 'approved', undefined, note);
      break;
    case 'deny':
      ok = approvals.resolve(rec.id, 'denied', undefined, note);
      break;
    case 'stop':
      ok = approvals.resolve(rec.id, 'stopped', undefined, note);
      break;
    case 'alter':
      if (!updatedInput || typeof updatedInput !== 'object') {
        return res.status(400).json({ error: 'alter requires updatedInput object' });
      }
      ok = approvals.resolve(rec.id, 'altered', updatedInput, note);
      break;
    default:
      return res.status(400).json({ error: 'unknown action' });
  }
  return ok ? res.json({ ok: true, approval: approvals.get(rec.id) }) : res.status(409).json({ error: 'race lost' });
});

// Server-Sent Events stream of the full approval list.
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (list: unknown) => res.write(`data: ${JSON.stringify(list)}\n\n`);
  send(approvals.list());
  const onChange = (list: unknown) => send(list);
  approvals.on('change', onChange);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(keepAlive);
    approvals.off('change', onChange);
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, pending: approvals.pending().length }));

// Serve the built dashboard if present (web/dist).
const webDist = path.resolve(__dirname, '../../web/dist');
app.use(express.static(webDist));
app.get(/^(?!\/api|\/pre-tool-use).*/, (_req, res, next) => {
  res.sendFile(path.join(webDist, 'index.html'), (err) => {
    if (err) next();
  });
});

// Periodic prune of old resolved records.
setInterval(() => approvals.prune(), 5 * 60 * 1000).unref();

function summarize(input: HookInput): string {
  const cmd = (input.tool_input?.command as string) ?? JSON.stringify(input.tool_input);
  return `${input.tool_name}: ${String(cmd).slice(0, 120)}`;
}
function noteReason(base: string, note?: string): string {
  return note ? `${base} — ${note}` : base;
}

app.listen(config.port, () => {
  console.log(`\n  Claude Code permission gateway`);
  console.log(`  hook endpoint : http://localhost:${config.port}/pre-tool-use`);
  console.log(`  dashboard     : http://localhost:${config.port}/  (or web dev server)`);
  console.log(`  hold timeout  : ${config.approvalTimeoutMs}ms, onExpire=${config.onExpire}\n`);
});
