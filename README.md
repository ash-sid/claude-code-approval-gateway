# Claude Code Approval Gateway

A human-in-the-loop permission layer for Claude Code. It answers the `PreToolUse` hook:
safe tool calls are auto-allowed with no interruption, risky ones have their HTTP
response **held open** while a push notification goes to your phone. Approve, deny, or
rewrite the command from anywhere. Ignore it and it **fails closed**.

```
                                        ┌───────────────────────────┐
Claude Code ──POST /pre-tool-use──▶ Gateway                         │
                                    │  policy engine                │
                                    ├─ safe      → allow (instant)  │
                                    ├─ unknown   → ask (native)     │
                                    └─ dangerous → HOLD ──┬──▶ dashboard (browser)
                                                          └──▶ ntfy push → phone
                                    ◀── held response resolves the tool call
                                        (auto-denies on timeout)
```

Remote approval runs over an ngrok tunnel, so the phone reaches the dashboard from cell
data.

---

## Why

Running an agent with broad tool permissions means either approving every call by hand —
exhausting, and you stop reading them — or granting blanket permission, which is fine
until it isn't. This sits in between: automate the boring majority, escalate the rest,
and make escalation cheap enough that you actually read it.

The constraint that shaped the design: **a missed prompt must never become an approval.**
Timeouts, disconnects, and unrecognized tools all resolve toward denial.

---

## Project status

Two server implementations live here. This is a migration in progress, not an accident.

| | `server/server.js` | `server/src/` (TypeScript) |
|---|---|---|
| **Runtime** | Vanilla Node, zero dependencies | Express + TypeScript |
| **Dashboard** | HTML embedded in the file, 1.2s polling | React + Vite + Tailwind, SSE with polling fallback |
| **Auth** | Bearer token on all non-hook routes | **None — localhost only** |
| **Phone approval** | ntfy push + ngrok tunnel | Not yet |
| **Verdicts** | allow / hold | allow / ask / dangerous |
| **Protected paths** | Bash commands only | Read *and* write tools, incl. `~/.ssh`, `.aws/credentials` |
| **Status** | **Run this one today** | Migration target |

`server.js` is the version that works end-to-end including remote approval, so it's the
one to run. The TypeScript tree has the better policy engine and UI but no auth, which
makes it unsafe to expose through a tunnel. Porting auth, push, and tunnel-blocking into
it — then deleting `server.js` — is the next work.

---

## Layout

| Path | What |
|------|------|
| `server/server.js` | The running gateway. Server, policy engine, pending store, ntfy push, and dashboard HTML in one dependency-free file. |
| `server/src/policy.config.ts` | Rule lists (`autoAllow`, `dangerous`) and timeouts. **The file you tune.** |
| `server/src/policy.ts` | Evaluation logic — dangerous first, then autoAllow, else ask. |
| `server/src/approvals.ts` | In-memory pending store; one promise per held request. |
| `server/src/index.ts` | Routes and the exact hook JSON responses. |
| `web/src/` | React dashboard. Built to `web/dist`, served by the TS gateway at `/`. |
| `scripts/start.sh` | Config + launcher for `server.js`. **Gitignored** — holds live secrets. |
| `scripts/start.sh.example` | Template. Copy to `start.sh` and fill in. |
| `scripts/smoke-test.sh` | Reproduces allow / ask / hold+approve round-trips with `curl`. |
| `.claude/settings.json` | Hook registration for `server.js` (600s timeout). |
| `settings.hook.json` | Hook registration for the TS gateway (120s timeout). |

---

## Setup

**Requires:** Node 18+, [ngrok](https://ngrok.com) for remote approval, and the
[ntfy](https://ntfy.sh) app on your phone.

### 1. Configure

```bash
cp scripts/start.sh.example scripts/start.sh
chmod +x scripts/start.sh
```

| Variable | How to get it |
|---|---|
| `NGROK_DOMAIN` | Your reserved ngrok domain, e.g. `something.ngrok-free.app` |
| `NTFY_TOPIC` | `openssl rand -hex 16` — subscribe your phone's ntfy app to this exact string |
| `AUTH_TOKEN` | `openssl rand -hex 32` |

The ntfy topic is a password, not a name. On the public ntfy.sh server, anyone who knows
the topic string can read every notification it carries.

### 2. Run

```bash
./scripts/start.sh
```

Starts the tunnel and the server together; a `trap` tears down both on Ctrl+C so you
never leave an orphaned tunnel or a busy port.

```
  Approval gateway running
  Dashboard:  http://localhost:4517
  Hook URL:   http://localhost:4517/pre-tool-use
  Auth:       required (AUTH_TOKEN set, 64 chars)
  Push:       on, via https://ntfy.sh
  Public URL: https://your-domain.ngrok-free.app
```

Refusing to start means `AUTH_TOKEN` isn't exported — deliberate, see
[Security model](#security-model).

### 3. Register the hook

Merge `.claude/settings.json` into `~/.claude/settings.json` (user-level) or keep it
project-level:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "http", "url": "http://localhost:4517/pre-tool-use", "timeout": 600 }
        ]
      }
    ]
  }
}
```

The `http` hook type means Claude Code POSTs the payload directly — no shell wrapper.
`matcher: ""` fires on every tool; narrow to `"Bash"` to gate only shell commands.
`timeout` is in **seconds** and must exceed the server's hold window (5 min) so the
server always answers before Claude Code gives up.

Restart Claude Code, then run `/hooks` to confirm registration.

### 4. Verify

```bash
curl -i localhost:4517/api/pending                          # → 401
curl -i -H "Authorization: Bearer $AUTH_TOKEN" \
     localhost:4517/api/pending                             # → 200
curl -i -X POST localhost:4517/pre-tool-use \
     -H "x-forwarded-for: 1.2.3.4" -d '{}'                  # → 403
```

Then ask Claude Code to `rm -rf` something disposable and confirm your phone buzzes.

### Running the TypeScript gateway instead

Localhost only — it has no auth yet. Don't expose it.

```bash
cd server && npm install && npm start     # tsx src/index.ts, port 4517
cd web && npm install && npm run build    # → web/dist, served at /
```

Use `settings.hook.json` (120s) for the hook registration, and `scripts/smoke-test.sh`
to exercise the round-trips.

---

## Policy engine

`server.js` evaluates in this order:

1. **Read/write tools** (`Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`) → allow.
2. **Bash** → tested against every `DANGER` pattern. Any match holds the call and shows
   the matched labels as risk chips.
3. **Anything else** → hold. Unrecognized tools are unknown-risk, not safe.

`DANGER` covers recursive and forced deletes, `rmdir`, Windows `del /f`, `sudo`, `mkfs`,
`dd if=`, `git push --force`, `git reset --hard`, redirects into system directories or
`/dev`, `shutdown`, `reboot`, drive formatting, and any command touching `.env`.

The TypeScript engine adds an `ask` verdict that defers to Claude's native prompt for
unclassified calls, matched-evidence strings on each risk factor, and
`protectedPathPattern` checks on file tools — so `Read ~/.ssh/id_rsa` is caught, which
`server.js` currently misses.

### The known weakness

This is regex matching, so it fails both ways. `rm -rf $BUILD_DIR` is flagged
identically to `rm -rf /`, and a dangerous command nobody wrote a rule for passes
straight through. Every false positive also trains you to approve reflexively — the
exact failure mode the tool exists to prevent.

Testing surfaced a sharper version of the same problem. Asked to delete a file with
`rm -rf`, the agent reasoned that the flags were unnecessary for a plain file and ran
`rm testing.txtt` instead. That is *better* behaviour — and it sails straight through the
gate, because `DANGER` keys on the `-r`/`-f` flags rather than on the destructive act.
The same blind spot covers `mv important.txt /tmp/`, truncation via `> file.txt`, and
`git checkout -- .`.

The lesson is that danger is a property of intent and context, not of syntax. A blocklist
can only enumerate spellings, and the agent rephrases faster than the list grows.
Replacing it with a learned classifier is [on the roadmap](#roadmap).

---

## How decisions map to the hook response

All responses use Claude Code's `hookSpecificOutput` shape.

| Action | Response |
|---|---|
| Auto-allowed by policy | `permissionDecision: "allow"`, immediate |
| **Approve** | `permissionDecision: "allow"` |
| **Alter** then approve | `"allow"` + `updatedInput.command` with your rewrite |
| **Deny** | `permissionDecision: "deny"` |
| No decision before timeout | `"deny"` (or `"ask"` in the TS gateway, per `ON_EXPIRE`) |
| Claude Code disconnects first | Pending entry dropped, timer cleared |
| **Stop session** *(TS only)* | `"deny"` + `continue: false` — halts Claude entirely |
| No rule matched *(TS only)* | `permissionDecision: "ask"` |

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Command altered & approved via gateway",
    "updatedInput": { "command": "rm -rf ./node_modules" }
  }
}
```

---

## Security model

The gateway is reachable from the public internet through the tunnel, and the alter path
hands an arbitrary command back to Claude Code for execution. An unauthenticated
instance is therefore remote code execution on the host. The defenses in `server.js`:

**Fail-closed everywhere.** Timeout denies. Unrecognized tools hold rather than pass.
Disconnects drop the request rather than leaking a response.

**Bearer token on every route except the hook.** `AUTH_TOKEN` is accepted as an
`Authorization: Bearer` header, a `?t=` query param for the notification tap-through, or
an `HttpOnly` cookie the dashboard sets on load. Comparison uses
`crypto.timingSafeEqual`. The server refuses to start without a token rather than
falling back to an insecure default.

**`/pre-tool-use` is token-exempt but tunnel-blocked.** Claude Code's hook config sends
no custom headers, so that route can't require a token. It instead rejects any request
carrying `x-forwarded-for` or `ngrok-trace-id` — headers ngrok adds that a remote client
can't strip. A loopback-IP check wouldn't work: the ngrok agent runs locally, so
tunneled requests also arrive from `127.0.0.1`.

**Secrets stay out of the repo.** The server reads everything from the environment;
`scripts/start.sh` holds live values and is gitignored. Only the template ships.

### Known limitations

- The notification tap-through URL embeds the token, so it's visible on the phone's lock
  screen. Accepted tradeoff for one-tap approval.
- The TypeScript gateway has no auth and must stay on localhost until the port lands.
- `server.js` auto-allows read tools on any path, including secrets. Fixed in the TS
  policy engine, not yet in the running one.
- Pending approvals are in memory; a restart drops the queue. Held connections die with
  it, so nothing is silently approved.
- Single shared token, no per-device revocation.
- Trust in the tunnel provider is inherent to the design.

---

## Roadmap

**Migration.** Port auth, ntfy push, and tunnel-blocking into the TypeScript gateway,
then retire `server.js` and consolidate on one implementation.

**Learned risk classification.** Log every tool call and decision to JSONL, including a
random sample of auto-allowed calls so the training data isn't censored by the existing
rules. Train a classifier on command text plus context (cwd, git state), tune the
threshold for recall on the destructive class rather than accuracy — a false negative
executes `rm -rf /`, a false positive costs one tap — and keep the regex list as a hard
override in front of it.

---

## License

MIT
