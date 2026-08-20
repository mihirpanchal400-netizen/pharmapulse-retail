import { IMPORT_DEFS, importDef } from './fields';
import type { ColumnMapping, ImportType, TargetField } from './types';

/**
 * Import Center - smart column detection.
 *
 * The user must always be able to override what is detected here, so this file
 * is allowed to guess. What it is not allowed to do is guess *confidently and
 * wrongly*: a weak match is returned as no match, leaving the column unmapped
 * and visible in the mapping screen, rather than quietly writing MRP into the
 * purchase-price column.
 */

/**
 * Reduces a header to a comparable token: lower case, no punctuation, no
 * spaces, and with the noise words Indian exports sprinkle through headers
 * removed ("Rate (Rs.)" and "RATE RS" both become "rate").
 */
export function normaliseHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(rs|inr|rupees|amt|amount|value|in|per|of|the|no|nos|dt)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/** Character-level similarity, used only as a tie-breaker for near-misses. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  // Levenshtein distance, single-row variant.
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = temp;
    }
  }
  const distance = previous[b.length];
  return 1 - distance / Math.max(a.length, b.length);
}

/**
 * Scores one header against one target field.
 *
 * 1.00  the header is exactly one of the field's known names
 * 0.80  the header contains a known name as a whole word-ish substring
 * <0.8  fuzzy character similarity, only trusted above 0.86
 */
export function scoreField(header: string, field: TargetField): number {
  const token = normaliseHeader(header);
  if (token === '') return 0;

  const candidates = [field.label, field.key, ...field.synonyms].map(normaliseHeader);

  let best = 0;
  for (const candidate of candidates) {
    if (candidate === '') continue;
    if (token === candidate) return 1;

    // Substring matches are directional: a header "productname" containing the
    // synonym "product" is a good sign, but a two-character synonym inside a
    // long header is noise, hence the length floor.
    if (candidate.length >= 4 && token.includes(candidate)) {
      best = Math.max(best, 0.8 + Math.min(candidate.length / token.length, 1) * 0.1);
      continue;
    }
    if (token.length >= 4 && candidate.includes(token)) {
      best = Math.max(best, 0.78);
      continue;
    }

    const ratio = similarity(token, candidate);
    if (ratio > 0.86) best = Math.max(best, ratio * 0.85);
  }
  return best;
}

/** Below this, a match is discarded and the column is left for the user. */
const ACCEPT_THRESHOLD = 0.7;

export interface FieldMatch {
  field: string;
  column: string;
  score: number;
}

/**
 * Builds the suggested mapping for a sheet.
 *
 * Assignment is greedy on the best score across the whole grid, and each column
 * and each field is used at most once. That matters for the common case of a
 * file with both "Rate" and "MRP": whichever pairing scores highest is fixed
 * first, so the second field cannot also grab the same column.
 */
export function suggestMapping(
  headers: string[],
  type: ImportType,
): { mapping: ColumnMapping; matches: FieldMatch[] } {
  const def = importDef(type);

  const scored: FieldMatch[] = [];
  for (const field of def.fields) {
    for (const header of headers) {
      const score = scoreField(header, field);
      if (score >= ACCEPT_THRESHOLD) scored.push({ field: field.key, column: header, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const mapping: ColumnMapping = {};
  for (const field of def.fields) mapping[field.key] = null;

  const usedColumns = new Set<string>();
  const matches: FieldMatch[] = [];
  for (const candidate of scored) {
    if (mapping[candidate.field]) continue;
    if (usedColumns.has(candidate.column)) continue;
    mapping[candidate.field] = candidate.column;
    usedColumns.add(candidate.column);
    matches.push(candidate);
  }

  return { mapping, matches };
}

/**
 * Picks the most likely import type for a sheet.
 *
 * Headers carry most of the signal; the sheet name is a tie-breaker, because a
 * tab called "Suppliers" holding product columns is more often a mislabelled tab
 * than a supplier list. Coverage of *required* fields is weighted heavily -
 * matching twelve optional product columns means little if the sheet has no
 * product name at all.
 */
export function detectImportType(
  sheetName: string,
  headers: string[],
): { type: ImportType | null; confidence: number; scores: { type: ImportType; score: number }[] } {
  const name = sheetName.toLowerCase();
  const scores: { type: ImportType; score: number }[] = [];

  for (const def of Object.values(IMPORT_DEFS)) {
    const { matches } = suggestMapping(headers, def.type);
    if (matches.length === 0) {
      scores.push({ type: def.type, score: 0 });
      continue;
    }

    const matched = new Set(matches.map((m) => m.field));

    // How much of what this import type needs is present.
    const needed = def.fields.filter((f) => f.required).map((f) => f.key);
    const anyOfGroups = def.requireAnyOf ?? [];
    const requiredHit = needed.length === 0 ? 1 : needed.filter((k) => matched.has(k)).length / needed.length;
    const anyOfHit =
      anyOfGroups.length === 0
        ? 1
        : anyOfGroups.filter((g) => g.keys.some((k) => matched.has(k))).length / anyOfGroups.length;

    // How much of the sheet this import type explains, and how well.
    const coverage = matches.length / Math.max(headers.length, 1);
    const quality = matches.reduce((sum, m) => sum + m.score, 0) / matches.length;

    const nameHit = def.nameHints.some((hint) => name.includes(hint)) ? 1 : 0;

    const score =
      requiredHit * 0.3 + anyOfHit * 0.25 + Math.min(coverage, 1) * 0.2 + quality * 0.15 + nameHit * 0.1;

    scores.push({ type: def.type, score: Number(score.toFixed(4)) });
  }

  scores.sort((a, b) => b.score - a.score);
  const winner = scores[0];

  // A sheet the detector barely recognises is better reported as unknown; the
  // user then picks the type deliberately.
  if (!winner || winner.score < 0.5) return { type: null, confidence: winner?.score ?? 0, scores };

  return { type: winner.type, confidence: winner.score, scores };
}

/**
 * Stable signature of a header set, used to remember a mapping across uploads
 * of the same monthly file. Order-independent, so a distributor reordering two
 * columns still hits the saved mapping.
 */
export function headerSignature(headers: string[]): string {
  return headers
    .map(normaliseHeader)
    .filter((h) => h !== '')
    .sort()
    .join(',');
}
