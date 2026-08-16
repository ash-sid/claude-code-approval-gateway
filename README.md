# Claude Code Approval Gateway

A human-in-the-loop permission layer for Claude Code. It answers the `PreToolUse` hook:
safe tool calls are auto-allowed with no interruption, risky ones have their HTTP
response **held open** while a push notification goes to your phone. Approve, deny, or
rewrite the command from anywhere. Ignore it and it **fails closed**.

```
Claude Code ──POST /pre-tool-use──▶ Gateway
                                    │  policy engine
                                    ├─ safe         → allow (instant)
                                    ├─ dangerous    → HOLD ──┬──▶ dashboard (browser)
                                    └─ unrecognized → HOLD ──┴──▶ ntfy push → phone
                                    ◀── held response resolves the tool call
                                        (auto-denies on timeout)
```

The held HTTP response *is* the mechanism. Nothing is queued or replayed — the hook call
blocks until a human decides or the timer expires. Remote approval runs over an ngrok
tunnel, so the phone reaches the dashboard from cell data.

One file, zero dependencies, no build step, no `package.json`.

---

## Why

Running an agent with broad tool permissions means either approving every call by hand —
exhausting, and you stop reading them — or granting blanket permission, which is fine
until it isn't. This sits in between: automate the boring majority, escalate the rest,
and make escalation cheap enough that you actually read it.

The constraint that shaped the design: **a missed prompt must never become an approval.**
Timeouts, disconnects, and unrecognized tools all resolve toward denial — as long as the
gateway is running. See [Measured failure modes](#measured-failure-modes) for the case
where that guarantee does not hold.

---

## Layout

| Path | What |
|------|------|
| `server/server.js` | The entire gateway. Server, policy engine, pending store, ntfy push, and dashboard HTML in one dependency-free file. |
| `scripts/start.sh` | Config + launcher. **Gitignored** — holds live secrets. |
| `scripts/start.sh.example` | Template. Copy to `start.sh` and fill in. |
| `settings.hook.json` | Hook registration block to copy into your settings file (600s timeout). Nothing loads this file directly. |

### Why there is only one implementation

A TypeScript port lived in `server/src/` and `web/` for part of this project's life:
Express, a React dashboard, SSE instead of polling, and a three-verdict policy engine that
added an `ask` outcome deferring unclassified calls to Claude Code's native prompt.

It was removed rather than finished. The port had no auth and no phone push, which are the
two things that make the gateway useful away from the keyboard, and its protected-path
pattern had fallen behind `server.js` — missing `authorized_keys` and `.claude/`.
Completing it meant porting three working subsystems across to reach parity with something
that already ran, and until that landed every policy change had to be made twice and kept
in sync by hand.

The `ask` verdict is the one thing genuinely lost. `server.js` has no middle ground, so
ordinary file edits auto-allow rather than deferring to Claude's own prompt.

The port's removal also deleted `scripts/smoke-test.sh`, which targeted the TypeScript API
only. **The repo currently has no automated tests.** A `.js` harness that posts directly
to `/pre-tool-use` is the next piece of work.

---

## Setup

**Requires:** Node 18+, [ngrok](https://ngrok.com) for remote approval, and the
[ntfy](https://ntfy.sh) app on your phone. No `npm install` — there are no dependencies.

### 1. Configure

```bash
cp scripts/start.sh.example scripts/start.sh
chmod +x scripts/start.sh
```

| Variable | How to get it |
|---|---|
| `NGROK_DOMAIN` | Your reserved ngrok domain, e.g. `something.ngrok-free.app` or `.ngrok-free.dev` |
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

The hook can be registered at either level. Both use the same block:

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

**Global** — `~/.claude/settings.json`. Gates every project. That file also holds
unrelated user settings, so **merge, don't overwrite**, and back it up first:

    cp ~/.claude/settings.json ~/.claude/settings.json.bak

**Project-level** — `.claude/settings.json` in the project you want gated. Scoped to
that one project, which is useful when you only want the gateway on for a sandbox.
Project settings apply based on where Claude Code was launched from, so you have to
`cd` into that project in your terminal and start Claude Code there. Opening the
folder some other way won't pick it up.

> **Don't register it project-level inside this repo.** The gateway would gate the
> edits you're making to the gateway, so a policy mistake locks you out of the file
> that would fix it. Run Claude Code in a disposable project instead.

The `http` hook type means Claude Code POSTs the payload directly — no shell wrapper.
`matcher: ""` fires on every tool; narrow to `"Bash"` to gate only shell commands.

`timeout` is in **seconds** and must exceed the gateway's hold window, because these
are two independent timers. The gateway sends `deny` when its own timer expires, but
if Claude Code has already stopped waiting, that response goes to a socket nobody is
reading. Whichever timer is shorter is your real review window. The shipped defaults —
600s hook against a 300s hold — put the gateway's timer first, which is correct.

Restart Claude Code fully — quit, not just reload — then run `/hooks` to confirm.

### 4. Verify

```bash
curl -i localhost:4517/api/pending                          # → 401
curl -i -H "Authorization: Bearer $AUTH_TOKEN" \
     localhost:4517/api/pending                             # → 200
curl -i -X POST localhost:4517/pre-tool-use \
     -H "x-forwarded-for: 1.2.3.4" -d '{}'                  # → 403
```

Then ask Claude Code to `rm -rf` something disposable and confirm your phone buzzes.

---

## The gateway is not the only hook

`/hooks` may show `PreToolUse (2)` or more. Every registration whose matcher covers the
tool being called fires, each returns its own verdict independently, and **any `deny`
beats any `allow`.** Registrations come from user settings, project settings, and
installed plugins.

Two consequences:

- A gateway `allow` is **not sufficient** for a tool call to run — something else may
  still block it.
- A gateway `deny` is **always sufficient** to stop it.

The asymmetry runs the safe way: other hooks can only add denials, so the core invariant
survives them intact. But it means an end-to-end test result is only attributable to this
gateway if no other registration's matcher overlaps the tool under test. Check `/hooks`
and compare matchers — the count alone tells you nothing. A plugin registering
`PreToolUse` on `Read` has no bearing on a `Bash` test.

---

## Policy engine

`server.js` evaluates in this order:

1. **File tools** (`Read`, `Glob`, `Grep`, `NotebookRead`, `Write`, `Edit`, `MultiEdit`,
   `NotebookEdit`) → allow, **unless the target path is protected** — `.env`, `id_rsa`,
   `id_ed25519`, `authorized_keys`, `.ssh/`, `.aws/credentials`, `.claude/` — which
   holds. The `.claude/` entry matters: without it, an `Edit` there rewrites the hook
   config and switches the gateway off through the gateway.
2. **Bash** → tested against every `DANGER` pattern. Any match holds the call and shows
   the matched labels as risk chips.
3. **Anything else** → hold. Unrecognized tools are unknown-risk, not safe.

`DANGER` covers recursive and forced deletes, `rmdir`, Windows `del /f`, `sudo`, `mkfs`,
`dd if=`, piping remote content into a shell (`curl … | sh`), `git push --force`,
`git reset --hard`, redirects into system directories or `/dev`, `shutdown`, `reboot`,
drive formatting, and any command touching `.env`.

### The known weakness

This is regex matching, so it fails both ways. `rm -rf $BUILD_DIR` is flagged
identically to `rm -rf /`, and a dangerous command nobody wrote a rule for passes
straight through. Every false positive also trains you to approve reflexively — the
exact failure mode the tool exists to prevent.

Testing surfaced a sharper version of the same problem. Asked to delete a file with
`rm -rf`, the agent reasoned that the flags were unnecessary for a plain file and ran
`rm testing.txt` instead. That is *better* behaviour — and it sails straight through the
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
| No decision before `AUTO_DENY_MS` | `"deny"` |
| Claude Code disconnects first | Pending entry dropped, timer cleared, logged `ABANDONED` |

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

## Measured failure modes

Both cases below were run end-to-end against a live gateway rather than reasoned about,
and the result was read from the filesystem rather than from the transcript.

### Gateway held past its window → fails closed ✅

A held card left unanswered auto-denies at `AUTO_DENY_MS` (300s). Because the hook
timeout is 600s, Claude Code is still listening when that verdict arrives and reports the
call denied. Nothing further happens at 600s — the response is already closed.

### Gateway down → fails open ❌

With the gateway stopped, Claude Code reports the hook failure and **runs the command
anyway**:

```
PreToolUse:Bash hook error
HTTP undefined from http://localhost:4517/pre-tool-use
```

`rm -rf test.txt` executed. No native permission prompt appeared. A `PreToolUse` hook that
cannot reach its endpoint is bypassed rather than treated as a denial.

This is not fixable inside `server.js` — there is no code you can add to a server that
isn't running. **The fail-closed guarantee is conditional on the gateway process being
alive, and the gateway cannot enforce that condition itself.** Anyone relying on this for
real protection should treat process liveness as part of the threat model. The intended
mitigation is a `SessionStart` hook that refuses to open a session against an unreachable
gateway.

---

## Security model

The gateway is reachable from the public internet through the tunnel, and the alter path
hands an arbitrary command back to Claude Code for execution. An unauthenticated
instance is therefore remote code execution on the host. The defenses:

**Fail-closed everywhere — while running.** Timeout denies. Unrecognized tools hold rather
than pass. Disconnects drop the request rather than leaking a response. The scope limit is
[above](#measured-failure-modes).

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

- **Gateway-down fails open.** See [Measured failure modes](#measured-failure-modes).
  The most significant limitation here.
- **No automated tests.** The only harness targeted the removed TypeScript API.
- The notification tap-through URL embeds the token, so it's visible on the phone's lock
  screen. Accepted tradeoff for one-tap approval.
- **Alter is Bash-only.** The rewritten command goes back as `updatedInput.command`,
  which is the wrong shape for `Write`/`Edit`. Approve and Deny work correctly on
  file-tool holds; Alter does not.
- Protected-path matching runs on the literal path string, with no normalization. A
  symlink or an unusual relative path can route around it.
- `AUTO_DENY_MS` is hardcoded at 5 minutes; changing it means editing the source.
- Pending approvals are in memory; a restart drops the queue. Held connections die with
  it, so nothing is silently approved.
- Single shared token, no per-device revocation.
- Trust in the tunnel provider is inherent to the design.

---

## Roadmap

**Correctness.** Fix the Alter shape for file tools, normalize paths before the protected
check, and make `AUTO_DENY_MS` configurable.

**Test harness.** A `.js` smoke test posting directly to `/pre-tool-use` — no Claude Code
in the loop, so no plugin interference and no command rephrasing, and it runs in seconds
rather than minutes.

**Session preflight.** A `SessionStart` hook that refuses to start against an unreachable
gateway, closing the fail-open gap.

**Learned risk classification.** Log every tool call and decision to JSONL, including a
random sample of auto-allowed calls so the training data isn't censored by the existing
rules. Train a classifier on command text plus context (cwd, git state), tune the
threshold for recall on the destructive class rather than accuracy — a false negative
executes `rm -rf /`, a false positive costs one tap — and keep the regex list as a hard
override in front of it.

---

## License

MIT
