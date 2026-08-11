#!/usr/bin/env node
/*
 * Claude Code approval gateway.
 *
 * A dependency-free Node server that gates Claude Code's tool calls behind a
 * human decision:
 *
 *   POST /pre-tool-use   PreToolUse hook endpoint. Safe calls return "allow"
 *                        immediately; risky ones hold the HTTP response open
 *                        and surface a card in the dashboard.
 *   GET  /               Approval dashboard (Approve / Alter / Deny).
 *   GET  /api/pending    Current queue.
 *   POST /api/decision   Record a decision.
 *
 * FAIL-CLOSED: an undecided request is auto-denied after AUTO_DENY_MS, so a
 * missed prompt can never leak a command through.
 *
 * AUTH: every endpoint except /pre-tool-use requires AUTH_TOKEN, supplied as
 * an Authorization: Bearer header, a ?t= query param, or the session cookie
 * the dashboard sets. /pre-tool-use is exempt because Claude Code's hook
 * config sends no headers — it is instead refused if it arrives through the
 * tunnel rather than from the local hook.
 *
 * Configuration and startup live in scripts/start.sh — see start.sh.example.
 */

const http = require("http");
const crypto = require("crypto");

const PORT = 4517;
const AUTO_DENY_MS = 5 * 60 * 1000; // auto-deny a pending request after 5 min

// ---------------------------------------------------------------------------
// Auth configuration
// ---------------------------------------------------------------------------
// Refuse to start unconfigured. A gateway that silently runs without auth is
// worse than one that won't run at all: the tunnel would expose the decision
// API, and the "alter" path turns that into remote code execution.
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
if (!AUTH_TOKEN) {
  console.error("\n  AUTH_TOKEN is not set. Refusing to start.");
  console.error("  Generate one with:  openssl rand -hex 32");
  console.error("  Then set it in scripts/start.sh\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Push notifications (ntfy)
// ---------------------------------------------------------------------------
// Set NTFY_TOPIC to enable. Use a long, random topic name: on the public
// ntfy.sh server the topic name is the ONLY thing keeping strangers out, so
// treat it like a password.
//
// PUBLIC_URL must be your tunnel URL for the phone buttons and links to work
// (the phone hits these URLs directly). If unset it falls back to localhost,
// which is fine for a local test but won't work from your phone.
const NTFY_SERVER = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
const NTFY_TOPIC = process.env.NTFY_TOPIC || ""; // empty = notifications off
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

// ---------------------------------------------------------------------------
// Policy: what auto-allows vs. what must be reviewed
// ---------------------------------------------------------------------------
const SAFE_TOOLS = ["Edit", "Write", "MultiEdit", "Read", "Glob", "Grep"];

const DANGER = [
  { re: /\brm\s+-\w*[rf]/i,            label: "Force/recursive delete (rm -rf)" },
  { re: /\brmdir\b/i,                  label: "Remove directory" },
  { re: /\bdel\s+\/[a-z]/i,            label: "Windows del /f /q" },
  { re: /\bsudo\b/,                    label: "Runs as superuser (sudo)" },
  { re: /\bmkfs\b/,                    label: "Formats a filesystem (mkfs)" },
  { re: /\bdd\s+if=/,                  label: "Raw disk write (dd)" },
  { re: /\bgit\s+push\b[^\n]*--force/i, label: "Force push" },
  { re: /\bgit\s+reset\s+--hard/i,     label: "Hard reset (discards work)" },
  { re: /(^|[^2])>\s*\/(etc|var|usr|bin|boot)\b/, label: "Redirect into a system dir" },
  { re: /(^|[^2])>\s*\/dev\/(?!null\b)/, label: "Write into /dev" },
  { re: /\bshutdown\b/i,               label: "Shutdown" },
  { re: /\breboot\b/i,                 label: "Reboot" },
  { re: /\bformat\s+[a-z]:/i,          label: "Format a drive" },
  { re: /\.env\b/,                     label: "Touches a .env file" },
];

function assess(tool, cmd) {
  if (SAFE_TOOLS.includes(tool)) return { decision: "allow", reasons: [] };
  if (tool === "Bash") {
    const reasons = DANGER.filter((d) => d.re.test(cmd)).map((d) => d.label);
    return reasons.length ? { decision: "hold", reasons } : { decision: "allow", reasons: [] };
  }
  return { decision: "hold", reasons: ["Unrecognized tool \u2014 review"] };
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function tokenOk(given) {
  if (!given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(AUTH_TOKEN);
  if (a.length !== b.length) return false; // length leak is unavoidable here
  return crypto.timingSafeEqual(a, b);
}

function presentedToken(req, query) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  const q = query.get("t");
  if (q) return q;
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)gw_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// The ngrok agent runs on this machine and connects to 127.0.0.1, so a
// loopback-IP check cannot tell tunneled traffic from local traffic. These
// headers can: ngrok adds them, and a remote client cannot strip them.
function viaTunnel(req) {
  return Boolean(req.headers["x-forwarded-for"] || req.headers["ngrok-trace-id"]);
}

// ---------------------------------------------------------------------------
// Pending requests (held hook responses waiting on a human decision)
// ---------------------------------------------------------------------------
const pending = new Map(); // id -> { id, tool, cmd, reasons, createdAt, res, timer }
let counter = 0;

function hookAllow(res, reason, updatedCommand) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: reason,
    },
  };
  if (updatedCommand) out.hookSpecificOutput.updatedInput = { command: updatedCommand };
  send(res, 200, out);
}

function hookDeny(res, reason) {
  send(res, 200, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

// Fire a push notification for a held request. Best-effort: any failure is
// logged and swallowed so it can never block or crash the approval flow.
async function notify(p) {
  if (!NTFY_TOPIC) return; // notifications disabled
  const cmd = p.cmd || `(${p.tool})`;
  const summary = cmd.length > 140 ? cmd.slice(0, 140) + "\u2026" : cmd;
  const decisionUrl = `${PUBLIC_URL}/api/decision`;

  // The action buttons post straight to the decision API from the phone, so
  // they have to carry the token themselves.
  const authHeaders = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
    Authorization: `Bearer ${AUTH_TOKEN}`,
  };

  const payload = {
    topic: NTFY_TOPIC,
    title: "Claude Code \u2014 approval required",
    message: `${summary}\n\n\u26a0 ${p.reasons.join(", ")}`,
    priority: 5, // max: buzz through, bypass quiet settings where allowed
    tags: ["warning"],
    // Tapping the body opens the dashboard already authenticated. This does
    // place the token in a notification on the phone — a known tradeoff,
    // documented in the README threat model.
    click: `${PUBLIC_URL}/?t=${encodeURIComponent(AUTH_TOKEN)}`,
    actions: [
      {
        action: "http",
        label: "Approve",
        url: decisionUrl,
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ id: p.id, action: "approve" }),
        clear: true, // dismiss the notification once the tap succeeds
      },
      {
        action: "http",
        label: "Deny",
        url: decisionUrl,
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ id: p.id, action: "deny" }),
        clear: true,
      },
    ],
  };

  try {
    // JSON publishing goes to the server ROOT, with the topic inside the body.
    const r = await fetch(NTFY_SERVER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.log(`ntfy publish failed: HTTP ${r.status}`);
  } catch (e) {
    console.log(`ntfy publish error: ${e.message}`);
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
    });
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const [url, qs] = req.url.split("?");
  const query = new URLSearchParams(qs || "");

  // 1) The hook endpoint Claude Code calls before each tool.
  //    No token: the hook config sends no headers. Instead it must originate
  //    from the local hook, never from the tunnel.
  if (req.method === "POST" && url === "/pre-tool-use") {
    if (viaTunnel(req)) {
      console.log("REJECT /pre-tool-use arrived via tunnel");
      return send(res, 403, { error: "forbidden" });
    }

    const input = await readBody(req);
    const tool = input.tool_name || "";
    const cmd = (input.tool_input && input.tool_input.command) || "";
    const { decision, reasons } = assess(tool, cmd);

    if (decision === "allow") {
      console.log(`ALLOW  ${tool}  ${cmd.slice(0, 70)}`);
      return hookAllow(res, "Auto-approved by policy");
    }

    // Hold: park the response, show it on the dashboard, fail closed on timeout
    const id = `req_${Date.now()}_${counter++}`;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        console.log(`AUTO-DENY (timeout)  ${id}`);
        hookDeny(res, "Auto-denied: no approval within time limit");
        pending.delete(id);
      }
    }, AUTO_DENY_MS);

    const entry = { id, tool, cmd, reasons, createdAt: Date.now(), res, timer };
    pending.set(id, entry);
    console.log(`HELD   ${tool}  ${cmd.slice(0, 70)}  [${reasons.join(", ")}]`);
    notify(entry); // fire-and-forget push to the phone

    // If Claude Code gives up first, clean up so we don't leak the response
    req.on("close", () => {
      if (pending.has(id)) { clearTimeout(timer); pending.delete(id); }
    });
    return; // response stays open on purpose
  }

  // --- Everything below this line requires the token. ---
  if (!tokenOk(presentedToken(req, query))) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }

  // 2) Dashboard polls this for the current queue
  if (req.method === "GET" && url === "/api/pending") {
    const list = [...pending.values()].map(({ id, tool, cmd, reasons, createdAt }) =>
      ({ id, tool, cmd, reasons, createdAt }));
    return send(res, 200, { pending: list });
  }

  // 3) Dashboard posts your decision here
  if (req.method === "POST" && url === "/api/decision") {
    const { id, action, command } = await readBody(req);
    const p = pending.get(id);
    if (!p) return send(res, 404, { error: "not found or already handled" });
    clearTimeout(p.timer);
    pending.delete(id);
    if (action === "approve") {
      const altered = command && command !== p.cmd ? command : undefined;
      console.log(`APPROVE ${id}${altered ? " (altered)" : ""}`);
      hookAllow(p.res, "Approved via dashboard", altered);
    } else {
      console.log(`DENY   ${id}`);
      hookDeny(p.res, "Denied via dashboard");
    }
    return send(res, 200, { ok: true });
  }

  // 4) The dashboard page itself. Setting the cookie here means the page's
  //    own fetch() calls are authenticated automatically from then on.
  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Set-Cookie": `gw_token=${encodeURIComponent(AUTH_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
    });
    return res.end(DASHBOARD);
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`\n  Approval gateway running`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Hook URL:   http://localhost:${PORT}/pre-tool-use`);
  console.log(`  Auth:       required (AUTH_TOKEN set, ${AUTH_TOKEN.length} chars)`);
  if (NTFY_TOPIC) {
    console.log(`  Push:       on, via ${NTFY_SERVER}`);
    console.log(`  Public URL: ${PUBLIC_URL}`);
    if (PUBLIC_URL.includes("localhost")) {
      console.log(`  \u26a0 PUBLIC_URL is localhost \u2014 phone buttons won't work until you set it to your tunnel URL.`);
    }
  } else {
    console.log(`  Push:       off (set NTFY_TOPIC to enable)`);
  }
  console.log("");
});

// ---------------------------------------------------------------------------
// Dashboard page (plain HTML/CSS/JS, no build step)
// ---------------------------------------------------------------------------
const DASHBOARD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Claude Code Approvals</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, system-ui, "Segoe UI", sans-serif;
    background: #0f1117; color: #e6e8ee; padding: 28px 20px;
  }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
  header h1 { font-size: 18px; font-weight: 650; margin: 0; letter-spacing: .2px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #3ddc84;
         box-shadow: 0 0 0 4px rgba(61,220,132,.15); }
  .empty { color: #6b7180; text-align: center; padding: 60px 0; font-size: 15px; }
  .card {
    background: #171a23; border: 1px solid #232735; border-radius: 14px;
    padding: 18px 18px 16px; margin: 0 auto 16px; max-width: 640px;
    box-shadow: 0 8px 24px rgba(0,0,0,.25);
  }
  .card .top { display: flex; justify-content: space-between; align-items: center;
               margin-bottom: 12px; }
  .badge { font-size: 12px; font-weight: 600; color: #ffb020;
           background: rgba(255,176,32,.12); padding: 4px 10px; border-radius: 999px; }
  .tool { font-size: 12px; color: #7b8194; }
  .cmd {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13.5px;
    background: #0c0e14; border: 1px solid #232735; border-radius: 9px;
    padding: 12px 14px; color: #d7e0ff; white-space: pre-wrap; word-break: break-all;
  }
  .cmd[contenteditable="true"] { outline: 2px solid #4b7bec; background: #0a0d18; }
  .risks { margin: 12px 0 4px; display: flex; flex-wrap: wrap; gap: 6px; }
  .risk { font-size: 12px; color: #ff8a8a; background: rgba(255,90,90,.10);
          border: 1px solid rgba(255,90,90,.25); padding: 3px 9px; border-radius: 7px; }
  .actions { display: flex; gap: 10px; margin-top: 16px; }
  button {
    flex: 1; border: none; border-radius: 9px; padding: 11px 0; font-size: 14px;
    font-weight: 600; cursor: pointer; transition: filter .12s ease;
  }
  button:hover { filter: brightness(1.12); }
  .approve { background: #2fbf71; color: #04150c; }
  .deny { background: #e0554e; color: #1a0605; }
  .alter { background: #2b3040; color: #cdd3e2; }
  .hint { font-size: 11px; color: #6b7180; margin-top: 10px; }
</style>
</head>
<body>
  <header><span class="dot"></span><h1>Claude Code Approvals</h1></header>
  <div id="queue"><div class="empty">Waiting for requests\u2026</div></div>
<script>
  var editing = {};
  function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML;}

  function render(list){
    var q = document.getElementById("queue");
    if(!list.length){ q.innerHTML = '<div class="empty">No pending requests. You\\'re all caught up.</div>'; return; }
    q.innerHTML = list.map(function(p){
      var risks = p.reasons.map(function(r){ return '<span class="risk">'+esc(r)+'</span>'; }).join("");
      return ''
        + '<div class="card" data-id="'+p.id+'">'
        +   '<div class="top"><span class="badge">Approval required</span>'
        +       '<span class="tool">'+esc(p.tool)+'</span></div>'
        +   '<div class="cmd" id="cmd-'+p.id+'">'+esc(p.cmd)+'</div>'
        +   '<div class="risks">'+risks+'</div>'
        +   '<div class="actions">'
        +     '<button class="approve" onclick="decide(\\''+p.id+'\\',\\'approve\\')">Approve</button>'
        +     '<button class="alter" onclick="toggleAlter(\\''+p.id+'\\')">Alter</button>'
        +     '<button class="deny" onclick="decide(\\''+p.id+'\\',\\'deny\\')">Deny</button>'
        +   '</div>'
        +   '<div class="hint">Alter lets you edit the command before approving.</div>'
        + '</div>';
    }).join("");
  }

  function toggleAlter(id){
    var el = document.getElementById("cmd-"+id);
    editing[id] = !editing[id];
    el.setAttribute("contenteditable", editing[id] ? "true" : "false");
    if(editing[id]) el.focus();
  }

  function decide(id, action){
    var el = document.getElementById("cmd-"+id);
    var command = editing[id] ? el.innerText : undefined;
    fetch("/api/decision", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ id: id, action: action, command: command })
    }).then(poll);
    editing[id] = false;
  }

  function poll(){
    fetch("/api/pending").then(function(r){return r.json();})
      .then(function(d){ render(d.pending); })
      .catch(function(){});
  }
  setInterval(poll, 1200);
  poll();
</script>
</body>
</html>`;
