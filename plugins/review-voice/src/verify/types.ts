export type Verdict = 'confirmed' | 'rejected' | 'uncertain';

/** What an external verifier is expected to emit on stdout, as JSON. */
export interface RawVerdict {
  verdict: Verdict;
  /** 0..1. A rejection below the drop threshold downgrades instead. */
  confidence?: number;
  reason?: string;
  /**
   * Optional correction when the verifier believes the tier is wrong. A weaker
   * tier applies; a stronger one is only a proposal for the tie-break, and
   * only with `decisive_evidence` to trace.
   */
  suggested_severity?: string;
  /** The lines the verdict turns on; see `DecisiveEvidence`. */
  decisive_evidence?: unknown;
  decisiveEvidence?: unknown;
}

/**
 * A line a second-pass verdict turns on, and why. Handed to the tie-breaker as
 * a place to look, never as a conclusion: a cross-check that read excerpts
 * missed the decisive lines, and one pointed at them settled the point.
 */
export interface DecisiveEvidence {
  path: string;
  line: number;
  why: string;
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
  /** Where the verdict's reason can be checked. Absent when it named none. */
  decisiveEvidence?: DecisiveEvidence[] | undefined;
  /**
   * A stronger tier the verifier traced, on a `kept` verdict. It changes
   * nothing by itself: `reconcile` sends it to the tie-break, and the tier
   * rises only on an upheld, traced ruling. See docs/adr/0019.
   */
  proposedSeverity?: string | undefined;
}

export interface VerificationReport {
  enabled: boolean;
  verifier: string | null;
  verdicts: FindingVerdict[];
  /** Verifiers that could not run. Never treated as confirmation. */
  didNotRun: string[];
  /**
   * Present when the pass is off because nothing is configured: how to turn
   * it on. A second model is the stand-in when another reviewer is
   * unavailable, and "enabled: false" alone did not say how to get one.
   */
  howToEnable?: string;
}
