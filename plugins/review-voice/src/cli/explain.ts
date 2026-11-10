import { describeScope, parseReviewScope, type ReviewScope } from '../diff/incremental.ts';
import { followUpHistory } from '../store/follow-ups.ts';
import { openDatabase } from '../store/db.ts';
import { runDetail, describeChecks, describeProvenance, describeStructure, type RecordedReproduction } from '../store/runs.ts';
import { describeStage, shallowPassWarning } from '../store/effort.ts';
import { backingAt, challengeFacts } from '../publish/evidence-block.ts';
import { planFindings } from '../publish/verdict.ts';
import { flag } from './shared.ts';

export function reviewScopeFromManifest(value: unknown): ReviewScope | undefined {
  return parseReviewScope(value) ?? undefined;
}

export function describeReviewScope(scope: ReviewScope | null): string | null {
  return describeScope(scope);
}

/** `<runner> <outcome> (run 1 exit N, run 2 exit M) <copy>`, the one line the spec fixes; the reason is the held line's. */
function describeReproduction(record: RecordedReproduction): string {
  const runs = record.runs.length === 0 ? 'no run' : record.runs.map((run, index) => `run ${index + 1} exit ${run.exitCode ?? 'none'}`).join(', ');
  const copy = record.copy === '' ? '' : ` ${record.copy}`;
  return `${record.runner} ${record.outcome} (${runs})${copy}`;
}

export function explainCommand(argv: string[]): number {
  const db = openDatabase();
  try {
    const detail = runDetail(db, flag(argv, '--run') ?? undefined);
    if (detail === null) {
      console.log('No review has been recorded yet.');
      return 0;
    }

    const wanted = argv.find((arg) => /^rv_\d+$/.test(arg));
    const verdicts = (Array.isArray(detail.verdicts) ? detail.verdicts : []) as {
      candidateId?: string;
      path: string;
      line: number;
      verdict: string;
      confidence: number;
      reason: string;
      outcome: string;
      originalSeverity: string;
      verifier: string;
    }[];
    const scores = (Array.isArray(detail.scores) ? detail.scores : []) as {
      candidateId?: string;
      path?: string;
      line?: number;
      technicalConfidence?: number;
      finalScore?: number;
      eligible?: boolean;
      novelty?: number;
      rejectedBecause?: string | null;
      duplicateOfPrecedent?: string | null;
      precedentIds?: string[];
      precedents?: { eventId?: string }[];
      fix?: {
        suggested?: string | null;
        verdict?: 'verified' | 'partial' | 'refuted' | 'absent' | null;
        confidence?: number | null;
        direction?: string | null;
        render?: 'fix' | 'direction' | 'none';
        reason?: string;
      };
      challenge?: { verdict?: unknown; line_ok?: unknown; corrected_line?: unknown; decisive_evidence?: unknown } | null;
      reanchoredFrom?: { line?: unknown } | null;
    }[];

    if (argv.includes('--json')) {
      console.log(JSON.stringify(detail, null, 2));
      return 0;
    }

    console.log(`Review ${detail.reviewRunId}`);
    console.log(`Recorded ${detail.createdAt}${detail.repository === null ? '' : ` for ${detail.repository}`}`);
    if (detail.pullNumber !== null) console.log(`Pull request #${detail.pullNumber}`);
    const recordedScope = describeReviewScope(detail.scope);
    if (recordedScope !== null) console.log(`Scope ${recordedScope}`);
    console.log(describeProvenance(detail.provenance));
    console.log(describeChecks(detail.checks));
    console.log(describeStructure(detail.structure));
    for (const stage of detail.stages) console.log(`Effort ${describeStage(stage)}`);
    const shallow = shallowPassWarning(detail.stages, detail.findings.length);
    if (shallow !== null) console.log(`Warning ${shallow}`);
    if (detail.complexity !== null) {
      console.log(
        detail.complexity.level === 'high'
          ? `Complexity high - ${detail.complexity.reasons.join('; ')}`
          : 'Complexity normal',
      );
    }
    console.log('');

    const history =
      detail.repository !== null && detail.pullNumber !== null
        ? followUpHistory(db, detail.repository, detail.pullNumber)
        : null;
    const shown = wanted === undefined ? detail.findings : detail.findings.filter((f) => f.findingId === wanted);
    // A run that posted nothing can still have held findings - below-gate
    // ones especially - and they are the only account of what it found.
    if (shown.length === 0 && wanted === undefined && detail.bodyFindings.length === 0) {
      console.log('No findings were recorded.');
      console.log('');
    } else if (shown.length === 0 && wanted !== undefined) {
      console.log(`No finding ${wanted}. Available: ${detail.findings.map((f) => f.findingId).join(', ') || 'none'}.`);
      return 1;
    }

    // The scores the posted blocks were read from, chosen as `post` chooses them.
    const planned = planFindings(detail.output, detail, (id) => runDetail(db, id));
    for (const finding of shown) {
      // Matched by location. An earlier version matched on a predicate that
      // never discriminated, so every finding showed the first finding's
      // numbers - worse than showing none, in the command whose whole purpose
      // is auditability.
      const score = scores.find((s) => s.path === finding.path && s.line === finding.line);
      console.log(`${finding.findingId}  [${finding.severity}] ${finding.path}:${finding.line}`);
      if (finding.carriedFrom !== undefined) {
        console.log(`  carried from      ${finding.carriedFrom.findingId} of run ${finding.carriedFrom.runId}`);
      }
      if (finding.partlyAddressed !== undefined) {
        const { prior, remaining, addressed } = finding.partlyAddressed;
        console.log(
          `  partly addressed  ${prior.author} at ${prior.path}:${prior.line}; ` +
            `${remaining.length} of ${remaining.length + addressed.length} still open: ${remaining.join('; ')}`,
        );
        // The state as later runs of the pull request found it; local only.
        const later = history?.get(`${detail.reviewRunId}:${finding.findingId}`);
        if (later?.state?.status === 'resolved') {
          console.log(`  follow-up         resolved in run ${later.stateRunId} - ${later.state.reason}`);
        } else if (later?.state?.status === 'open') {
          console.log(`  follow-up         open as of run ${later.stateRunId}: ${later.state.remaining.join('; ')}`);
        } else {
          console.log('  follow-up         open');
        }
      }
      console.log(`  category          ${finding.category ?? 'not recorded'}`);
      console.log(`  rule id           ${finding.ruleId ?? 'not recorded'}`);
      if (score?.technicalConfidence !== undefined) {
        console.log(`  technical         ${score.technicalConfidence.toFixed(2)}`);
      }
      if (score?.finalScore !== undefined) {
        console.log(`  final score       ${score.finalScore.toFixed(2)}`);
      }
      if (score?.novelty !== undefined) {
        console.log(`  novelty           ${score.novelty.toFixed(2)}`);
      }
      // Stored scores no longer carry `precedentIds`; the ids ride on `precedents`.
      const precedentIds =
        score?.precedentIds ??
        (score?.precedents ?? []).flatMap((p) => (typeof p.eventId === 'string' ? [p.eventId] : []));
      if (precedentIds.length > 0) {
        console.log(`  precedents        ${precedentIds.join(', ')}`);
      }
      if (score?.duplicateOfPrecedent != null) {
        console.log(`  already stated in ${score.duplicateOfPrecedent}`);
      }
      if (score?.fix !== undefined) {
        const fix = score.fix;
        const confidence =
          typeof fix.confidence === 'number' && Number.isFinite(fix.confidence)
            ? fix.confidence.toFixed(2)
            : 'unrecorded';
        if (fix.render === 'fix') {
          console.log(`  fix  verified ${confidence}`);
        } else if (fix.render === 'direction') {
          console.log(`  fix  direction (partial ${confidence})`);
        } else {
          const proposed = typeof fix.suggested === 'string' && fix.suggested.trim().length > 0;
          if (!proposed) {
            console.log('  fix  none proposed');
          } else {
            console.log(`  fix  withheld (${fix.verdict ?? 'not verified'}): ${fix.reason ?? 'no reason recorded'}`);
          }
        }
      }
      // Saying "no data" beats inventing a rationale after the fact.
      if (score === undefined) {
        console.log('  scoring           not recorded for this review');
      }

      const verdict = verdicts.find((v) => v.path === finding.path && v.line === finding.line);
      if (verdict !== undefined) {
        console.log(
          `  verified          ${verdict.verdict} (${verdict.confidence.toFixed(2)}) by ${verdict.verifier}` +
            (verdict.outcome === 'kept' ? '' : ` - ${verdict.outcome}`),
        );
        if (verdict.reason.length > 0) console.log(`                    ${verdict.reason}`);
        const ruling = detail.tieBreaks.find((t) => t.candidateId === verdict.candidateId);
        if (ruling !== undefined) {
          console.log(
            `  tie-break         ${ruling.upheld ? 'upheld' : 'not upheld'}` +
              `${ruling.applied === false ? ' (not applied)' : ''}` +
              `${ruling.raised === undefined ? '' : ` (raised to ${ruling.raised})`} - ${ruling.reason}`,
          );
        }
      }
      // The candidate `post` paired with the finding, so another candidate at its anchor cannot lend it a
      // record. A carried finding's pairing is in an earlier run, whose candidate ids this run reuses.
      const paired = [...planned.backing].find(([entry]) => entry.findingId === finding.findingId)?.[1];
      const candidateId = paired === undefined ? score?.candidateId : paired.runId === detail.reviewRunId ? paired.score.candidateId : undefined;
      const reproduction = detail.reproductions?.find((r) => candidateId !== undefined && r.candidateId === candidateId);
      if (reproduction !== undefined) console.log(`  reproduction      ${describeReproduction(reproduction)}`);
      // The facts the evidence block posts, from the score it posts them from, so the two agree.
      const challenge = challengeFacts(backingAt(planned, finding.path, finding.line)?.score ?? null);
      if (challenge !== null) {
        console.log(
          `  challenge         ${challenge.verdict}${challenge.line === null ? '' : ` (${challenge.line})`}` +
            (challenge.decisive.length === 0 ? '' : `; decisive ${challenge.decisive.join(', ')}`),
        );
      }
      if (finding.toolSignal !== undefined) {
        console.log(`  tool signal       ${finding.toolSignal.tool} line ${finding.toolSignal.line}: ${finding.toolSignal.text}`);
      }
      for (const entry of finding.conventionQuotes ?? []) console.log(`  convention        ${entry.path} "${entry.quote}"`);
      console.log('');
    }

    if (detail.bodyFindings.length > 0 && wanted === undefined) {
      console.log(`Body-only simplifications (${detail.bodyFindings.length}):`);
      for (const finding of detail.bodyFindings) {
        const { candidate } = finding;
        console.log(`  ${candidate.claim}`);
        console.log(
          `  removes           ${candidate.removes
            .map((element) => `${element.path}:${element.line} (${element.element})`)
            .join('; ')}`,
        );
        console.log(
          `  uses              ${candidate.abstraction.path}:${candidate.abstraction.line} ` +
            `(${candidate.abstraction.name})`,
        );
        console.log('  verdict           never affects the verdict');
      }
      console.log('');
    }

    // Earlier runs' partly-addressed follow-ups, as this run found them.
    if (detail.followUps.length > 0 && wanted === undefined) {
      console.log(`Follow-ups from earlier runs (${detail.followUps.length}):`);
      for (const f of detail.followUps) {
        console.log(`  [${f.status}] ${f.findingId} of run ${f.runId}  ${f.path}:${f.line} - ${f.reason}`);
        if (f.status === 'open') console.log(`      still open: ${f.remaining.join('; ')}`);
      }
      console.log('');
    }

    // Held-back candidates, unlike the suppressed ones below, include repeats of
    // an existing comment and cross-check results that no verifier produced.
    if (detail.held.length > 0 && wanted === undefined) {
      console.log(`Held back (${detail.held.length}):`);
      for (const h of detail.held) {
        console.log(`  [${h.verdict}] ${h.path}:${h.line}  ${h.source} - ${h.reason}`);
        // A later stage can hold a finding whose reproduction ran, an exempt one the challenger refuted among them.
        // A reproduction-did-not-fail entry already carries its runner and reason on its own line.
        if (h.verdict === 'reproduction-did-not-fail') continue;
        const reproduction = detail.reproductions?.find((r) => h.candidateId !== undefined && r.candidateId === h.candidateId);
        if (reproduction !== undefined) console.log(`      reproduction  ${describeReproduction(reproduction)}`);
      }
      console.log('');
    }

    // Findings the verifier removed leave no other trace. Showing them is what
    // makes a bad verifier visible rather than indistinguishable from a clean
    // diff.
    // A drop an upheld tie-break overturned was not a suppression. A ruling
    // reconcile marked not applied overturned nothing: it was on a candidate
    // nobody disputed, and hiding the drop on its account would hide a real
    // suppression. A ruling with no mark, as runs recorded before reconcile
    // marked them have, reads as it always did.
    const dropped = verdicts.filter(
      (v) =>
        v.outcome === 'dropped' &&
        !detail.tieBreaks.some(
          (t) => t.upheld && t.applied !== false && v.candidateId !== undefined && t.candidateId === v.candidateId,
        ),
    );
    if (dropped.length > 0 && wanted === undefined) {
      console.log(`Suppressed by verification (${dropped.length}):`);
      for (const v of dropped) {
        console.log(`  [${v.originalSeverity}] ${v.path}:${v.line}  ${v.verifier} @ ${v.confidence.toFixed(2)}`);
        if (v.reason.length > 0) console.log(`      ${v.reason}`);
        const ruling = detail.tieBreaks.find((t) => v.candidateId !== undefined && t.candidateId === v.candidateId);
        if (ruling !== undefined) {
          const state =
            ruling.applied === false ? `${ruling.upheld ? 'upheld' : 'not upheld'} but not applied` : 'not upheld';
          console.log(`      tie-break ${state} - ${ruling.reason}`);
        }
      }
      console.log('');
    }

    return 0;
  } finally {
    db.close();
  }
}
