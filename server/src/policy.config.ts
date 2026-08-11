/**
 * Policy configuration. Edit these lists to tune the gateway.
 *
 * Precedence when a Bash command is evaluated:
 *   1. If it matches ANY `dangerous` rule  -> hold for human approval.
 *   2. Else if it matches ANY `autoAllow`  -> allow immediately.
 *   3. Else                                -> ask (fall back to Claude's native prompt).
 *
 * Dangerous is checked first on purpose: a command like `git status && rm -rf /`
 * should never be auto-allowed just because it starts with a safe verb.
 */

export interface GatewayConfig {
  /** Port the gateway listens on. */
  port: number;
  /**
   * How long (ms) a dangerous request is held open waiting for a decision.
   * Keep this a few seconds BELOW the hook `timeout` in settings.json so the
   * gateway responds before Claude Code gives up on the connection.
   */
  approvalTimeoutMs: number;
  /**
   * Verdict returned when an approval expires with no human decision.
   * "deny" is fail-closed (safest). "ask" falls back to Claude's native prompt.
   */
  onExpire: 'deny' | 'ask';
  /** Tool names that are always safe regardless of input (read-only tools). */
  autoAllowTools: string[];
  /** Safe Bash command patterns -> allow immediately. */
  autoAllow: PolicyRule[];
  /** Destructive/sensitive patterns -> require human approval. */
  dangerous: DangerRule[];
}

export interface PolicyRule {
  /** Stable id shown in logs/dashboard. */
  id: string;
  /** Regex tested against the Bash command string (or file path). */
  pattern: RegExp;
}

export interface DangerRule extends PolicyRule {
  /** Machine code for the risk factor this rule contributes. */
  code: string;
  /** Human-readable description of the risk. */
  label: string;
}

export const config: GatewayConfig = {
  port: Number(process.env.PORT ?? 4517),
  approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS ?? 110_000),
  onExpire: (process.env.ON_EXPIRE as 'deny' | 'ask') ?? 'deny',

  // Read-only tools: never destructive, allow without a prompt.
  autoAllowTools: ['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'WebFetch', 'WebSearch'],

  autoAllow: [
    { id: 'ls', pattern: /^\s*ls(\s|$)/ },
    { id: 'pwd', pattern: /^\s*pwd\s*$/ },
    { id: 'cat-nonsecret', pattern: /^\s*cat\s+(?!.*\.env)\S+\s*$/ },
    { id: 'echo', pattern: /^\s*echo(\s|$)/ },
    { id: 'which', pattern: /^\s*which\s+\S+/ },
    { id: 'node-version', pattern: /^\s*(node|npm|pnpm|yarn|python3?|go|cargo)\s+(-v|--version|version)\s*$/ },
    { id: 'git-readonly', pattern: /^\s*git\s+(status|diff|log|show|branch|remote|fetch|rev-parse|describe)(\s|$)/ },
    { id: 'npm-run-safe', pattern: /^\s*(npm|pnpm|yarn)\s+(run\s+)?(test|lint|typecheck|build|format)(\s|$)/ },
    { id: 'grep-tools', pattern: /^\s*(grep|rg|find|head|tail|wc|sort|uniq|jq)\s+/ },
  ],

  dangerous: [
    {
      id: 'rm-recursive',
      code: 'recursive-delete',
      label: 'Recursive/forced file deletion (rm -r / rm -f)',
      pattern: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*(r|f)[a-zA-Z]*\b|\brm\s+-[rf]/,
    },
    {
      id: 'rm-root',
      code: 'protected-path-delete',
      label: 'Deletion targeting a protected/root path (/, ~, /etc, ..)',
      pattern: /\brm\b[^\n]*\s(\/|~|\/etc|\/usr|\/var|\/System|\.\.)(\/|\s|$)/,
    },
    {
      id: 'sudo',
      code: 'sudo',
      label: 'Privilege escalation with sudo/su/doas',
      pattern: /\b(sudo|doas|su)\b/,
    },
    {
      id: 'force-push',
      code: 'force-push',
      label: 'Git force-push (rewrites remote history)',
      pattern: /\bgit\s+push\b[^\n]*\s(--force\b|--force-with-lease\b|-f\b)/,
    },
    {
      id: 'git-hard-reset',
      code: 'history-rewrite',
      label: 'Destructive git operation (reset --hard / clean -fd / branch -D)',
      pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s|branch\s+-D)\b/,
    },
    {
      id: 'force-flag',
      code: 'force-flag',
      label: 'Force flag on a destructive command',
      pattern: /(^|\s)(--force\b|-f\b|-rf\b|-fr\b)/,
    },
    {
      id: 'env-read',
      code: 'secret-read',
      label: 'Reads a .env / secrets file (credential exfiltration risk)',
      pattern: /(cat|less|more|head|tail|cp|scp|curl\s+-T|xxd|nl|strings)\s+[^\n]*\.env(\.|\b)|\.env($|\s|['"])/,
    },
    {
      id: 'protected-write',
      code: 'protected-path-write',
      label: 'Writes/redirects into a protected system path',
      pattern: />\s*\/(etc|usr|var|bin|sbin|boot|System)\//,
    },
    {
      id: 'pipe-to-shell',
      code: 'remote-exec',
      label: 'Pipes remote content straight into a shell (curl|sh)',
      pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/,
    },
    {
      id: 'disk-write',
      code: 'disk-destroy',
      label: 'Raw disk / filesystem destruction (dd, mkfs, fdisk)',
      pattern: /\b(dd\s+if=|mkfs|fdisk|diskutil\s+erase)\b/,
    },
    {
      id: 'chmod-777',
      code: 'insecure-perms',
      label: 'Overly permissive chmod (777) or recursive chown',
      pattern: /\bchmod\s+(-R\s+)?777\b|\bchown\s+-R\b/,
    },
    {
      id: 'kill-all',
      code: 'process-kill',
      label: 'Mass process termination (kill -9, pkill, killall)',
      pattern: /\b(killall|pkill)\b|\bkill\s+-9\b/,
    },
  ],
};

/** File paths a non-Bash tool (Read/Edit/Write) must not touch without review. */
export const protectedPathPattern = /(^|\/)\.env(\.|$)|(^|\/)(id_rsa|id_ed25519|\.aws\/credentials|\.ssh\/)/;
