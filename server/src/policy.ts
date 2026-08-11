import type { HookInput, PolicyVerdict, RiskFactor } from './types.js';
import { config, protectedPathPattern } from './policy.config.js';

/** Pull the primary string we should scan out of a tool's input. */
function extractSubject(input: HookInput): { text: string; kind: 'command' | 'path' | 'other' } {
  const ti = input.tool_input ?? {};
  if (input.tool_name === 'Bash' && typeof ti.command === 'string') {
    return { text: ti.command, kind: 'command' };
  }
  // File tools: scan the target path for protected files.
  const path = (ti.file_path ?? ti.path ?? ti.notebook_path) as string | undefined;
  if (typeof path === 'string') return { text: path, kind: 'path' };
  return { text: JSON.stringify(ti), kind: 'other' };
}

/**
 * Evaluate a hook input against the policy.
 * Order: dangerous first (fail-safe), then autoAllow, else ask.
 */
export function evaluate(input: HookInput): PolicyVerdict {
  const { text, kind } = extractSubject(input);

  // 1. Always-safe read-only tools.
  if (config.autoAllowTools.includes(input.tool_name)) {
    // ...unless a file tool is pointed at a protected/secret path.
    if (kind === 'path' && protectedPathPattern.test(text)) {
      return {
        kind: 'dangerous',
        reason: `${input.tool_name} targets a protected/secret file: ${text}`,
        matchedRule: 'protected-file-access',
        riskFactors: [{ code: 'secret-read', label: 'Accesses a secret/credentials file', evidence: text }],
      };
    }
    return { kind: 'allow', reason: `Read-only tool ${input.tool_name}`, matchedRule: 'autoAllowTools' };
  }

  // Non-Bash write tools (Edit/Write/MultiEdit/NotebookEdit): only flag protected paths,
  // otherwise ask (let Claude's native permission flow handle ordinary edits).
  if (input.tool_name !== 'Bash') {
    if (kind === 'path' && protectedPathPattern.test(text)) {
      return {
        kind: 'dangerous',
        reason: `${input.tool_name} writes to a protected/secret file: ${text}`,
        matchedRule: 'protected-file-write',
        riskFactors: [{ code: 'secret-write', label: 'Writes to a secret/credentials file', evidence: text }],
      };
    }
    return { kind: 'ask', reason: `Unclassified ${input.tool_name} call` };
  }

  // 2. Bash: dangerous patterns first (checked against the FULL command).
  const riskFactors: RiskFactor[] = [];
  let firstMatchedRule = '';
  for (const rule of config.dangerous) {
    const m = text.match(rule.pattern);
    if (m) {
      if (!firstMatchedRule) firstMatchedRule = rule.id;
      riskFactors.push({ code: rule.code, label: rule.label, evidence: m[0].trim() });
    }
  }
  if (riskFactors.length > 0) {
    return {
      kind: 'dangerous',
      reason: `Bash command matched ${riskFactors.length} risk factor(s)`,
      matchedRule: firstMatchedRule,
      riskFactors,
    };
  }

  // 3. Auto-allow safe patterns.
  for (const rule of config.autoAllow) {
    if (rule.pattern.test(text)) {
      return { kind: 'allow', reason: `Matched safe pattern "${rule.id}"`, matchedRule: rule.id };
    }
  }

  // 4. Default: ask.
  return { kind: 'ask', reason: 'No policy rule matched; deferring to human/native prompt' };
}
