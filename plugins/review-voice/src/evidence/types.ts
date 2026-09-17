/**
 * Static tools produce structured evidence, never review prose. A finding
 * cites evidence; evidence does not argue for a finding.
 */
export interface EvidenceSignal {
  kind: string;
  path: string | null;
  line: number | null;
  claim: string;
  /** Verbatim tool output supporting the claim, so it stays attributable. */
  evidence: string[];
  confidence: number;
  tool: string;
}

export interface CommandOutcome {
  name: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  /** Set when the command could not run at all, as distinct from failing. */
  unavailable?: string;
  signals: EvidenceSignal[];
}

export interface EvidenceReport {
  enabled: boolean;
  /**
   * Every signal from every command, flattened. Always present, empty when
   * collection is off - a caller told to "pass the signals" should not have to
   * discover that the key is absent.
   */
  signals: EvidenceSignal[];
  commands: CommandOutcome[];
  /**
   * Tools that did not run. The reviewer must never imply a check passed when
   * it never executed.
   */
  didNotRun: string[];
}
