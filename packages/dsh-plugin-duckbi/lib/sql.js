/**
 * Read-only SQL gating.
 *
 * `duckbi_query` lets a model write SQL against the user's warehouse, so the
 * dangerous half of SQL is refused before it reaches DuckDB. This is a guard
 * against accidents and prompt-injected carelessness, not a security boundary:
 * the honest boundary is that the model runs with the user's own file permissions.
 * @module @duckbi/dsh-plugin-duckbi/lib/sql
 */

/** Statement heads that cannot modify anything. */
const READ_ONLY_HEADS = new Set([
  'select',
  'with',
  'from',
  'values',
  'describe',
  'desc',
  'show',
  'summarize',
  'explain',
  'table',
  'pivot',
  'unpivot',
])

/** Tokens that mutate, install, or reach outside the database. */
const FORBIDDEN_TOKENS = new Set([
  'insert',
  'update',
  'delete',
  'merge',
  'drop',
  'create',
  'alter',
  'copy',
  'attach',
  'detach',
  'install',
  'load',
  'export',
  'import',
  'truncate',
  'vacuum',
  'checkpoint',
  'call',
  'begin',
  'commit',
  'rollback',
  'grant',
  'revoke',
  'set',
  'reset',
  'pragma',
  'use',
])

/**
 * Scan SQL into tokens, ignoring string literals, quoted identifiers and comments
 * while tracking parenthesis depth so only top-level keywords are considered.
 * @param {string} sql - SQL text.
 * @returns {{tokens: {text: string, depth: number}[], statements: number}} tokens plus statement count.
 */
export function scanSql(sql) {
  /** @type {{text: string, depth: number}[]} */
  const tokens = []
  let depth = 0
  let statements = 1
  let index = 0
  const text = String(sql)

  while (index < text.length) {
    const char = text[index]

    // Line comment
    if (char === '-' && text[index + 1] === '-') {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end + 1
      continue
    }
    // Block comment
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 2
      continue
    }
    // String literal ('' escapes a quote inside it)
    if (char === "'") {
      index += 1
      while (index < text.length) {
        if (text[index] === "'" && text[index + 1] === "'") {
          index += 2
          continue
        }
        if (text[index] === "'") {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    // Quoted identifier
    if (char === '"') {
      index += 1
      while (index < text.length) {
        if (text[index] === '"' && text[index + 1] === '"') {
          index += 2
          continue
        }
        if (text[index] === '"') {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    // Dollar-quoted string
    if (char === '$') {
      const tagMatch = /^\$[A-Za-z_]*\$/.exec(text.slice(index))
      if (tagMatch) {
        const tag = tagMatch[0]
        const end = text.indexOf(tag, index + tag.length)
        index = end === -1 ? text.length : end + tag.length
        continue
      }
    }
    if (char === '(' || char === '[') {
      depth += 1
      index += 1
      continue
    }
    if (char === ')' || char === ']') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    if (char === ';') {
      statements += 1
      index += 1
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1
      while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end += 1
      tokens.push({ text: text.slice(index, end).toLowerCase(), depth })
      index = end
      continue
    }
    index += 1
  }
  // A trailing `;` yields one empty trailing statement; count only real ones.
  const realStatements = Math.max(1, countRealStatements(text))
  return { tokens, statements: realStatements }
}

/**
 * Count non-empty statements separated by semicolons, ignoring quoted regions.
 * @param {string} sql - SQL text.
 * @returns {number} the number of statements.
 */
function countRealStatements(sql) {
  const withoutStrings = String(sql)
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
  return withoutStrings
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean).length
}

/**
 * Validate that a SQL string is a single read-only query.
 * @param {string} sql - the model-supplied SQL.
 * @param {object} [options] - gating options.
 * @param {boolean} [options.allowWrite] - permit mutating statements.
 * @returns {string} the statement without its trailing semicolons.
 * @throws {Error} with a teaching message when the statement is refused.
 */
export function assertReadOnlyQuery(sql, options = {}) {
  const text = String(sql ?? '').trim()
  if (text === '') throw new Error('`sql` is empty — pass a SELECT query')

  const { tokens, statements } = scanSql(text)
  if (statements > 1) {
    throw new Error(
      'DuckBI runs one statement at a time and `sql` contained several. ' +
        'Send a single SELECT (use a CTE — `WITH ... SELECT` — to build intermediate results).',
    )
  }
  if (options.allowWrite) return text.replace(/;+\s*$/, '')
  if (tokens.length === 0) throw new Error('`sql` contains no statement')

  const head = tokens[0].text
  if (!READ_ONLY_HEADS.has(head)) {
    throw new Error(
      `DuckBI only runs read-only queries; \`${head}\` is refused. ` +
        'Use SELECT (or a WITH query) to inspect data — scans and refreshes are handled by `duckbi_source`.',
    )
  }
  const forbidden = tokens.find((token) => token.depth === 0 && FORBIDDEN_TOKENS.has(token.text))
  if (forbidden) {
    throw new Error(
      `DuckBI only runs read-only queries; the keyword \`${forbidden.text}\` is refused. ` +
        'Use SELECT (or a WITH query) to inspect data — scans and refreshes are handled by `duckbi_source`.',
    )
  }
  return text.replace(/;+\s*$/, '')
}

/**
 * Whether a SQL string is a single read-only statement, without throwing.
 * @param {string} sql - SQL text.
 * @returns {boolean} true when allowed.
 */
export function isReadOnlyQuery(sql) {
  try {
    assertReadOnlyQuery(sql)
    return true
  } catch {
    return false
  }
}
