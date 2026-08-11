export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'altered' | 'stopped' | 'expired';

export interface RiskFactor {
  code: string;
  label: string;
  evidence?: string;
}

export interface Approval {
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
  updatedInput?: Record<string, unknown>;
  decidedAt?: number;
}

export type DecisionAction = 'approve' | 'deny' | 'alter' | 'stop';
