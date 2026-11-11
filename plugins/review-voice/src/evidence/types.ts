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
  /**
   * The tool's own version line, so the audit record can name what ran. It comes
   * from the configured `version:` command, else from the producer name and
   * version a SARIF document states, and is absent when neither recorded one.
   */
  version?: string;
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
  /** Why no command ran at all, when an environment switch (not the config) stopped them. */
  skipped?: string;
  /**
   * The directory the commands ran in, absent when nothing was spawned. Under
   * the driver it is the pull request's head worktree, so a tool's absolute
   * path is resolved against it rather than the caller's checkout.
   */
  cwd?: string;
}
