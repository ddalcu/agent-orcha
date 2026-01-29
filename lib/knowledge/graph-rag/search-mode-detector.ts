/**
 * Heuristically detects whether a query should use local (entity-specific)
 * or global (thematic/community-summary) search mode.
 */
export type SearchMode = 'local' | 'global';

const GLOBAL_INDICATORS = [
  'overall', 'common', 'themes', 'patterns', 'summarize', 'summary',
  'across', 'trends', 'general', 'most frequent', 'overview', 'main topics',
  'all', 'broadly', 'generally', 'what are the', 'how do', 'what do',
  'in general', 'typically', 'aggregate', 'big picture',
];

const LOCAL_INDICATORS = [
  'who', 'which', 'tell me about', 'what is', 'what does',
  'describe', 'find', 'specific', 'details about', 'information on',
];

/**
 * Detect whether a query should use local or global search.
 * Default: local (more commonly useful for specific queries).
 */
export function detectSearchMode(query: string): SearchMode {
  const lower = query.toLowerCase().trim();

  // Score each mode
  let globalScore = 0;
  let localScore = 0;

  for (const indicator of GLOBAL_INDICATORS) {
    if (lower.includes(indicator)) {
      globalScore++;
    }
  }

  for (const indicator of LOCAL_INDICATORS) {
    if (lower.includes(indicator)) {
      localScore++;
    }
  }

  // Check for proper nouns (capitalized words not at start of sentence)
  const words = query.trim().split(/\s+/);
  const hasProperNouns = words.some((word, idx) => {
    if (idx === 0) return false; // Skip first word (always capitalized)
    return /^[A-Z][a-z]/.test(word);
  });

  if (hasProperNouns) {
    localScore += 2;
  }

  // Check if query mentions a specific name (quoted text)
  if (query.includes('"') || query.includes("'")) {
    localScore += 2;
  }

  if (globalScore > localScore) {
    return 'global';
  }

  // Default to local
  return 'local';
}
