/**
 * Shared readonly validation for Cypher and SQL queries.
 * Strips comments and string literals before checking for write keywords.
 */

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Strip single-line comments, multi-line comments, and string literals
 * so keyword detection doesn't get tricked by values inside strings/comments.
 */
function stripCommentsAndStrings(query: string): string {
  return query
    // Remove single-line comments (// or --)
    .replace(/\/\/.*$/gm, '')
    .replace(/--.*$/gm, '')
    // Remove multi-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Remove double-quoted strings
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    // Remove single-quoted strings
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    // Remove backtick-quoted identifiers
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const CYPHER_WRITE_KEYWORDS = [
  'CREATE',
  'DELETE',
  'MERGE',
  'SET',
  'REMOVE',
  'DROP',
  'DETACH',
  'CALL\\s+\\{', // CALL { ... } subqueries that could write
  'FOREACH',
];

const SQL_WRITE_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'CREATE',
  'GRANT',
  'REVOKE',
  'EXEC',
  'EXECUTE',
];

/**
 * Validate that a Cypher query is readonly (no mutations).
 */
export function validateReadonlyCypher(query: string): ValidationResult {
  if (!query.trim()) {
    return { valid: false, reason: 'Query cannot be empty.' };
  }

  const stripped = stripCommentsAndStrings(query);

  for (const keyword of CYPHER_WRITE_KEYWORDS) {
    // Match keyword as whole word (word boundary), case-insensitive
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(stripped)) {
      const cleanKeyword = keyword.replace(/\\s\+/, ' ').replace(/\\/, '');
      return {
        valid: false,
        reason: `Write operation "${cleanKeyword}" is not allowed. Only read queries (MATCH, RETURN, WITH, WHERE, ORDER BY, etc.) are permitted.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate that a SQL query is readonly (no mutations).
 */
export function validateReadonlySql(query: string): ValidationResult {
  if (!query.trim()) {
    return { valid: false, reason: 'Query cannot be empty.' };
  }

  const stripped = stripCommentsAndStrings(query);

  for (const keyword of SQL_WRITE_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(stripped)) {
      return {
        valid: false,
        reason: `Write operation "${keyword}" is not allowed. Only SELECT queries are permitted.`,
      };
    }
  }

  return { valid: true };
}
