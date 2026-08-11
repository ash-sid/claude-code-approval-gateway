import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { PendingApproval, ApprovalStatus, RiskFactor } from './types.js';

export interface ResolvedDecision {
  status: Exclude<ApprovalStatus, 'pending'>;
  updatedInput?: Record<string, unknown>;
  note?: string;
}

/**
 * In-memory store of approvals. Holds a resolver per pending record so the
 * HTTP hook handler can `await` a human decision (or expiry).
 */
class ApprovalStore extends EventEmitter {
  private records = new Map<string, PendingApproval>();
  private resolvers = new Map<string, (d: ResolvedDecision) => void>();
  private timers = new Map<string, NodeJS.Timeout>();

  create(params: {
    sessionId: string;
    cwd: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    reason: string;
    matchedRule: string;
    riskFactors: RiskFactor[];
    timeoutMs: number;
    onExpire: (d: ResolvedDecision) => void;
  }): { record: PendingApproval; decided: Promise<ResolvedDecision> } {
    const now = Date.now();
    const record: PendingApproval = {
      id: randomUUID(),
      status: 'pending',
      createdAt: now,
      expiresAt: now + params.timeoutMs,
      sessionId: params.sessionId,
      cwd: params.cwd,
      toolName: params.toolName,
      toolInput: params.toolInput,
      reason: params.reason,
      matchedRule: params.matchedRule,
      riskFactors: params.riskFactors,
    };
    this.records.set(record.id, record);

    const decided = new Promise<ResolvedDecision>((resolve) => {
      this.resolvers.set(record.id, resolve);
    });

    // Auto-expire.
    const timer = setTimeout(() => {
      const rec = this.records.get(record.id);
      if (rec && rec.status === 'pending') {
        rec.status = 'expired';
        rec.decidedAt = Date.now();
        this.emitChange();
        const resolver = this.resolvers.get(record.id);
        this.resolvers.delete(record.id);
        params.onExpire({ status: 'expired' });
        resolver?.({ status: 'expired' });
      }
    }, params.timeoutMs);
    this.timers.set(record.id, timer);

    this.emitChange();
    return { record, decided };
  }

  /** Resolve a pending approval from the dashboard. Returns false if not pending. */
  resolve(
    id: string,
    status: Exclude<ApprovalStatus, 'pending' | 'expired'>,
    updatedInput?: Record<string, unknown>,
    note?: string,
  ): boolean {
    const rec = this.records.get(id);
    if (!rec || rec.status !== 'pending') return false;

    rec.status = status;
    rec.decidedAt = Date.now();
    if (updatedInput) rec.updatedInput = updatedInput;

    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);

    const resolver = this.resolvers.get(id);
    this.resolvers.delete(id);
    resolver?.({ status, updatedInput, note });

    this.emitChange();
    return true;
  }

  list(): PendingApproval[] {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  pending(): PendingApproval[] {
    return this.list().filter((r) => r.status === 'pending');
  }

  get(id: string): PendingApproval | undefined {
    return this.records.get(id);
  }

  /** Drop resolved records older than `maxAgeMs` to bound memory. */
  prune(maxAgeMs = 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, rec] of this.records) {
      if (rec.status !== 'pending' && (rec.decidedAt ?? rec.createdAt) < cutoff) {
        this.records.delete(id);
      }
    }
  }

  private emitChange(): void {
    this.emit('change', this.list());
  }
}

export const approvals = new ApprovalStore();
