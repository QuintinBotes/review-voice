export type Verdict = 'confirmed' | 'rejected' | 'uncertain';

/** What an external verifier is expected to emit on stdout, as JSON. */
export interface RawVerdict {
  verdict: Verdict;
  /** 0..1. A rejection below the drop threshold downgrades instead. */
  confidence?: number;
  reason?: string;
  /** Optional correction when the verifier believes the tier is wrong. */
  suggested_severity?: string;
}

export interface FindingVerdict {
  candidateId: string;
  path: string;
  line: number;
  verdict: Verdict;
  confidence: number;
  reason: string;
  /** What actually happened to the finding as a result. */
  outcome: 'kept' | 'downgraded' | 'dropped' | 'unverified';
  originalSeverity: string;
  finalSeverity: string;
  /** Which verifier produced this, so a bad one can be identified later. */
  verifier: string;
}

export interface VerificationReport {
  enabled: boolean;
  verifier: string | null;
  verdicts: FindingVerdict[];
  /** Verifiers that could not run. Never treated as confirmation. */
  didNotRun: string[];
}
