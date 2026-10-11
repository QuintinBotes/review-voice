import { classifyAnchor, type FileHunks } from './diff/hunks.ts';
import { DEFAULT_LIMITS } from './contract/limits.ts';
import { countWords } from './contract/words.ts';
import { findForbiddenPhrases } from './contract/validate.ts';

/** One concrete concept a proposed restructuring makes unnecessary. */
export interface SimplificationElement {
  path: string;
  line: number;
  element: string;
}

/** The existing abstraction that takes over once the listed concepts are gone. */
export interface SimplificationAbstraction {
  path: string;
  line: number;
  name: string;
}

/** The one optional, body-only restructuring proposed for a review. */
export interface SimplificationCandidate {
  category: 'maintainability';
  claim: string;
  removes: SimplificationElement[];
  abstraction: SimplificationAbstraction;
}

/** The verifier must account for every proposed removal, not just the headline. */
export interface SimplificationVerification {
  verified: boolean;
  elements: { path: string; line: number; existsInDiff: boolean }[];
  behaviorPreserved: boolean;
  removesConcepts: boolean;
  reason: string;
}

/** A simplification that both agents agreed may be included in the review body. */
export interface VerifiedSimplification {
  candidate: SimplificationCandidate;
  verification: SimplificationVerification;
}

type Parsed<T> = { value: T; problem: null } | { value: null; problem: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): string | null {
  const unexpected = Object.keys(value).find((key) => !keys.includes(key));
  return unexpected === undefined ? null : `has an unexpected ${JSON.stringify(unexpected)} field`;
}

function text(value: unknown, name: string): Parsed<string> {
  if (typeof value !== 'string' || value.trim().length === 0) return { value: null, problem: `${name} must be non-empty text` };
  return { value: value.trim(), problem: null };
}

function line(value: unknown, name: string): Parsed<number> {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return { value: null, problem: `${name} must be a positive line number` };
  return { value: value as number, problem: null };
}

function element(value: unknown, index: number): Parsed<SimplificationElement> {
  const entry = record(value);
  if (entry === null) return { value: null, problem: `removes[${index}] must be an object` };
  const extra = onlyKeys(entry, ['path', 'line', 'element']);
  if (extra !== null) return { value: null, problem: `removes[${index}] ${extra}` };
  const path = text(entry['path'], `removes[${index}].path`);
  const at = line(entry['line'], `removes[${index}].line`);
  const name = text(entry['element'], `removes[${index}].element`);
  if (path.problem !== null || at.problem !== null || name.problem !== null) {
    return { value: null, problem: path.problem ?? at.problem ?? name.problem! };
  }
  return { value: { path: path.value!, line: at.value!, element: name.value! }, problem: null };
}

function abstraction(value: unknown): Parsed<SimplificationAbstraction> {
  const entry = record(value);
  if (entry === null) return { value: null, problem: 'abstraction must be an object' };
  const extra = onlyKeys(entry, ['path', 'line', 'name']);
  if (extra !== null) return { value: null, problem: `abstraction ${extra}` };
  const path = text(entry['path'], 'abstraction.path');
  const at = line(entry['line'], 'abstraction.line');
  const name = text(entry['name'], 'abstraction.name');
  if (path.problem !== null || at.problem !== null || name.problem !== null) {
    return { value: null, problem: path.problem ?? at.problem ?? name.problem! };
  }
  return { value: { path: path.value!, line: at.value!, name: name.value! }, problem: null };
}

/** Parses the specialised output of the opt-in simplification analyst pass. */
/** A removed element or abstraction is a name, not prose. */
const MAX_NAME_CHARS = 80;

export function parseSimplificationCandidate(value: unknown): Parsed<SimplificationCandidate | null> {
  const document = record(value);
  if (document === null) return { value: null, problem: 'expected {"simplification": ...}' };
  const extra = onlyKeys(document, ['simplification']);
  if (extra !== null) return { value: null, problem: `simplification output ${extra}` };
  const raw = document['simplification'];
  if (raw === null) return { value: null, problem: null };

  const candidate = record(raw);
  if (candidate === null) return { value: null, problem: 'simplification must be an object or null' };
  const candidateExtra = onlyKeys(candidate, ['category', 'claim', 'removes', 'abstraction']);
  if (candidateExtra !== null) return { value: null, problem: `simplification ${candidateExtra}` };
  if (candidate['category'] !== 'maintainability') {
    return { value: null, problem: 'simplification.category must be "maintainability"' };
  }
  const claim = text(candidate['claim'], 'simplification.claim');
  if (claim.problem !== null) return { value: null, problem: claim.problem };
  // shortcut: the default per-finding budget, not a configured one; thread ContractLimits here if a repository changes it.
  if (countWords(claim.value!) > DEFAULT_LIMITS.maxWordsPerFinding) {
    return { value: null, problem: `simplification.claim must be at most ${DEFAULT_LIMITS.maxWordsPerFinding} words, like any finding` };
  }
  if (!Array.isArray(candidate['removes']) || candidate['removes'].length === 0 || candidate['removes'].length > 50) {
    return { value: null, problem: 'simplification.removes must list between 1 and 50 concrete elements' };
  }
  const removes: SimplificationElement[] = [];
  for (const [index, rawElement] of candidate['removes'].entries()) {
    const parsed = element(rawElement, index);
    if (parsed.problem !== null) return { value: null, problem: parsed.problem };
    removes.push(parsed.value!);
  }
  const existing = abstraction(candidate['abstraction']);
  if (existing.problem !== null) return { value: null, problem: existing.problem };
  // Everything rendered into the posted body meets the same contract as a finding's prose.
  const posted = [claim.value!, ...removes.map((removed) => removed.element), existing.value!.name];
  if (posted.some((part) => part.length > MAX_NAME_CHARS && part !== claim.value)) {
    return { value: null, problem: `simplification element and abstraction names must be at most ${MAX_NAME_CHARS} characters` };
  }
  if (posted.some((part) => /[\u2013\u2014]/u.test(part))) {
    return { value: null, problem: 'simplification text contains an em or en dash; use a comma, a full stop, or a plain hyphen' };
  }
  const hedges = posted.flatMap((part) => findForbiddenPhrases(part, DEFAULT_LIMITS.forbiddenPhrases));
  if (hedges.length > 0) return { value: null, problem: `simplification text contains "${hedges[0]}"; state the problem rather than hedging` };
  return {
    value: { category: 'maintainability', claim: claim.value!, removes, abstraction: existing.value! },
    problem: null,
  };
}

/** Every proposed removal has to be a concrete changed location, never an inferred concept. */
export function simplificationDiffProblem(candidate: SimplificationCandidate, hunks: Map<string, FileHunks>): string | null {
  for (const removed of candidate.removes) {
    const anchor = classifyAnchor(hunks, removed.path, removed.line);
    if (!anchor.ok) {
      return `${removed.path}:${removed.line} is not a changed line in the diff (${anchor.kind})`;
    }
  }
  return null;
}

/** Parses and cross-checks the specialised evidence-verifier response. */
export function parseSimplificationVerification(
  value: unknown,
  candidate: SimplificationCandidate,
): Parsed<SimplificationVerification> {
  const verification = record(value);
  if (verification === null) return { value: null, problem: 'simplification verification must be an object' };
  const extra = onlyKeys(verification, ['verified', 'elements', 'behavior_preserved', 'removes_concepts', 'reason']);
  if (extra !== null) return { value: null, problem: `simplification verification ${extra}` };
  if (typeof verification['verified'] !== 'boolean') return { value: null, problem: 'simplification verification.verified must be true or false' };
  if (typeof verification['behavior_preserved'] !== 'boolean') {
    return { value: null, problem: 'simplification verification.behavior_preserved must be true or false' };
  }
  if (typeof verification['removes_concepts'] !== 'boolean') {
    return { value: null, problem: 'simplification verification.removes_concepts must be true or false' };
  }
  const reason = text(verification['reason'], 'simplification verification.reason');
  if (reason.problem !== null) return { value: null, problem: reason.problem };
  if (!Array.isArray(verification['elements']) || verification['elements'].length !== candidate.removes.length) {
    return { value: null, problem: 'simplification verification.elements must account for every listed removal' };
  }

  const elements: SimplificationVerification['elements'] = [];
  for (const [index, rawElement] of verification['elements'].entries()) {
    const entry = record(rawElement);
    if (entry === null) return { value: null, problem: `simplification verification.elements[${index}] must be an object` };
    const elementExtra = onlyKeys(entry, ['path', 'line', 'exists_in_diff']);
    if (elementExtra !== null) return { value: null, problem: `simplification verification.elements[${index}] ${elementExtra}` };
    const path = text(entry['path'], `simplification verification.elements[${index}].path`);
    const at = line(entry['line'], `simplification verification.elements[${index}].line`);
    if (path.problem !== null || at.problem !== null) return { value: null, problem: path.problem ?? at.problem! };
    if (typeof entry['exists_in_diff'] !== 'boolean') {
      return { value: null, problem: `simplification verification.elements[${index}].exists_in_diff must be true or false` };
    }
    const expected = candidate.removes[index]!;
    if (path.value !== expected.path || at.value !== expected.line) {
      return { value: null, problem: `simplification verification.elements[${index}] does not match ${expected.path}:${expected.line}` };
    }
    elements.push({ path: path.value!, line: at.value!, existsInDiff: entry['exists_in_diff'] as boolean });
  }

  const parsed: SimplificationVerification = {
    verified: verification['verified'],
    elements,
    behaviorPreserved: verification['behavior_preserved'],
    removesConcepts: verification['removes_concepts'],
    reason: reason.value!,
  };
  if (
    parsed.verified &&
    (!parsed.behaviorPreserved || !parsed.removesConcepts || parsed.elements.some((element) => !element.existsInDiff))
  ) {
    return {
      value: null,
      problem: 'a verified simplification needs every element in the diff, preserved behavior, and a removal rather than a move',
    };
  }
  return { value: parsed, problem: null };
}

/** Parses the persisted form accepted by `record --body-findings`. */
export function parseVerifiedSimplification(value: unknown, hunks: Map<string, FileHunks>): Parsed<VerifiedSimplification> {
  const entry = record(value);
  if (entry === null) return { value: null, problem: 'body finding must be an object' };
  const extra = onlyKeys(entry, ['candidate', 'verification']);
  if (extra !== null) return { value: null, problem: `body finding ${extra}` };
  const candidate = parseSimplificationCandidate({ simplification: entry['candidate'] });
  if (candidate.problem !== null || candidate.value === null) {
    return { value: null, problem: candidate.problem ?? 'body finding needs a simplification candidate' };
  }
  const inDiff = simplificationDiffProblem(candidate.value, hunks);
  if (inDiff !== null) return { value: null, problem: inDiff };
  const verification = parseSimplificationVerification(entry['verification'], candidate.value);
  if (verification.problem !== null) return { value: null, problem: verification.problem };
  if (!verification.value!.verified) return { value: null, problem: 'body finding verification must be verified' };
  return { value: { candidate: candidate.value, verification: verification.value! }, problem: null };
}

/** Rendered separately from scored findings, so it cannot become an inline comment or affect a verdict. */
export function renderSimplification(finding: VerifiedSimplification): string {
  const removed = finding.candidate.removes
    .map((element) => `\`${element.path}:${element.line}\` (${element.element})`)
    .join(', ');
  const abstraction = finding.candidate.abstraction;
  return (
    `**maintainability** - ${finding.candidate.claim} ` +
    `Remove ${removed}; use \`${abstraction.path}:${abstraction.line}\` (${abstraction.name}).`
  );
}
