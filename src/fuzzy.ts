export interface FuzzyMatch {
  score: number;
  indices: number[];
}

/**
 * Performs fuzzy matching of a query against a target string.
 * Returns match details with score and matched character indices, or null if no match.
 *
 * Scoring factors:
 * - Consecutive matches get bonus points
 * - Matches at word boundaries (start, after separator) score higher
 * - Earlier matches score higher
 * - Exact case matches get a small bonus
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query.length === 0) {
    return { score: 0, indices: [] };
  }

  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();

  // Quick check: all query chars must exist in target
  let checkIndex = 0;
  for (const char of queryLower) {
    const foundIndex = targetLower.indexOf(char, checkIndex);
    if (foundIndex === -1) {
      return null;
    }
    checkIndex = foundIndex + 1;
  }

  // Find best match using greedy algorithm with scoring
  const indices: number[] = [];
  let score = 0;
  let queryIndex = 0;
  let lastMatchIndex = -1;

  const CONSECUTIVE_BONUS = 15;
  const WORD_BOUNDARY_BONUS = 10;
  const EXACT_CASE_BONUS = 2;
  const POSITION_WEIGHT = 0.5;

  for (let i = 0; i < target.length && queryIndex < queryLower.length; i++) {
    if (targetLower[i] === queryLower[queryIndex]) {
      indices.push(i);

      // Base score for match
      let matchScore = 10;

      // Consecutive match bonus
      if (lastMatchIndex === i - 1) {
        matchScore += CONSECUTIVE_BONUS;
      }

      // Word boundary bonus (start of string or after separator)
      const previousChar = target[i - 1] ?? "";
      if (i === 0 || isWordBoundary(previousChar)) {
        matchScore += WORD_BOUNDARY_BONUS;
      }

      // Exact case bonus
      if (target[i] === query[queryIndex]) {
        matchScore += EXACT_CASE_BONUS;
      }

      // Position penalty (prefer earlier matches)
      matchScore -= i * POSITION_WEIGHT;

      score += Math.max(matchScore, 1);
      lastMatchIndex = i;
      queryIndex++;
    }
  }

  // All query characters must be matched
  if (queryIndex < queryLower.length) {
    return null;
  }

  return { score, indices };
}

const WORD_BOUNDARY_REGEX = /[/\\_\-.\s]/;

function isWordBoundary(char: string): boolean {
  return WORD_BOUNDARY_REGEX.test(char);
}

/**
 * Highlights matched characters in a string using ANSI escape codes.
 */
export function highlightMatch(text: string, indices: number[]): string {
  if (indices.length === 0) {
    return text;
  }

  const indexSet = new Set(indices);
  let result = "";
  let inHighlight = false;

  const BOLD = "\x1b[1m";
  const YELLOW = "\x1b[33m";
  const RESET = "\x1b[0m";

  for (let i = 0; i < text.length; i++) {
    const shouldHighlight = indexSet.has(i);

    if (shouldHighlight && !inHighlight) {
      result += BOLD + YELLOW;
      inHighlight = true;
    } else if (!shouldHighlight && inHighlight) {
      result += RESET;
      inHighlight = false;
    }

    result += text[i];
  }

  if (inHighlight) {
    result += RESET;
  }

  return result;
}

/**
 * Performs substring search (non-fuzzy) for content matching.
 * Returns the start index of the match or -1 if not found.
 */
export function substringMatch(
  query: string,
  target: string
): { index: number; length: number } | null {
  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();
  const index = targetLower.indexOf(queryLower);

  if (index === -1) {
    return null;
  }

  return { index, length: query.length };
}

/**
 * Highlights a substring match using ANSI escape codes.
 */
export function highlightSubstring(
  text: string,
  startIndex: number,
  length: number
): string {
  const BOLD = "\x1b[1m";
  const YELLOW = "\x1b[33m";
  const RESET = "\x1b[0m";

  const before = text.slice(0, startIndex);
  const match = text.slice(startIndex, startIndex + length);
  const after = text.slice(startIndex + length);

  return `${before}${BOLD}${YELLOW}${match}${RESET}${after}`;
}
