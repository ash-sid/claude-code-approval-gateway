/**
 * Types mirroring the Claude Code PreToolUse hook contract.
 * Reference: https://code.claude.com/docs/en/hooks
 */

/** Payload Claude Code POSTs to an `http` PreToolUse hook (JSON body). */
export interface HookInput {
  session_id: string;
  prompt_id?: string;
  transcript_path?: string;
  cwd: string;
  permission_mode?: 'default' | 'plan' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions';
  effort?: { level: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  hook_event_name: 'PreToolUse';
  tool_name: string;
  /** Tool arguments; for Bash this is `{ command, description? }`. */
  tool_input: Record<string, unknown>;
}

export type PermissionDecision = 'allow' | 'deny' | 'ask';

/**
 * The exact JSON body Claude Code expects back from a PreToolUse hook.
 * Only `hookSpecificOutput` is required for a decision; the universal fields
 * (`continue`, `stopReason`, `systemMessage`) are optional.
 */
export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: PermissionDecision;
    permissionDecisionReason?: string;
    /** Replaces the tool's input before execution (used by "Alter command"). */
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
  /** When false, stops Claude entirely (used by "Stop session"). */
  continue?: boolean;
  stopReason?: string;
  systemMessage?: string;
  suppressOutput?: boolean;
}

/** Outcome of running the policy engine against a hook input. */
export type PolicyVerdict =
  | { kind: 'allow'; reason: string; matchedRule: string }
  | { kind: 'ask'; reason: string }
  | { kind: 'dangerous'; reason: string; matchedRule: string; riskFactors: RiskFactor[] };

export interface RiskFactor {
  /** Short machine label, e.g. "recursive-delete", "sudo", "force-push". */
  code: string;
  /** Human-readable explanation shown in the dashboard. */
  label: string;
  /** The substring of the command/input that triggered this factor. */
  evidence?: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'altered' | 'stopped' | 'expired';

/** A dangerous tool call awaiting a human decision. */
export interface PendingApproval {
  id: string;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  sessionId: string;
  cwd: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  reason: string;
  matchedRule: string;
  riskFactors: RiskFactor[];
  /** Set once resolved via the dashboard. */
  updatedInput?: Record<string, unknown>;
  decidedAt?: number;
}

/** Decision the dashboard POSTs to resolve a pending approval. */
export type DecisionAction = 'approve' | 'deny' | 'alter' | 'stop';

export interface DecisionRequest {
  action: DecisionAction;
  /** Required for `alter`: the rewritten tool_input. */
  updatedInput?: Record<string, unknown>;
  /** Optional human note surfaced to Claude via permissionDecisionReason. */
  note?: string;
}
