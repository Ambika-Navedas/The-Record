import { pool } from './db.ts'

export interface KnowledgeDocRow {
  id: string
  org_id: string
  project_id: string | null
  type: string
  title: string
  excerpt: string
  owner_id: string
  keywords: string
  updated_at: string
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'for',
  'and', 'or', 'do', 'does', 'did', 'what', 'who', 'when', 'where', 'why', 'how', 'it', 'its',
  'this', 'that', 'we', 'us', 'our', 'i', 'you', 'your', 'right', 'now', 'anything', 'any',
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

function docText(doc: KnowledgeDocRow, projectName: string): string {
  const keywords = JSON.parse(doc.keywords) as string[]
  return [doc.title, doc.excerpt, projectName, keywords.join(' ')].join(' ')
}

// Synced emails are forwarded Zoom notifications: the first few lines are
// "---------- Forwarded message ---------" + From/Date/Subject/To headers, not
// real content. Strip that block so it never gets returned as "the answer." The
// Subject line often wraps across two physical lines with no header prefix on the
// continuation, so rather than parsing individual header lines, strip everything
// from the marker through the first blank line that follows it.
const FORWARD_MARKER_RE = /^-{5,}\s*forwarded message\s*-{5,}\s*\n/i

function stripEmailBoilerplate(text: string): string {
  const marker = text.match(FORWARD_MARKER_RE)
  if (!marker) return text.trim()
  const afterMarker = text.slice(marker[0].length)
  const blankLineIdx = afterMarker.search(/\n\s*\n/)
  if (blankLineIdx === -1) return afterMarker.trim()
  return afterMarker.slice(blankLineIdx).trim()
}

const URL_ONLY_RE = /^<?https?:\/\/\S+>?$/

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !URL_ONLY_RE.test(p))
}

const MIN_ANSWER_SCORE = 2

// The whole-document excerpt can run to thousands of characters (a full forwarded
// meeting-summary email covering a dozen topics). Returning it verbatim isn't an
// "answer" to a specific question. Instead, score individual paragraphs against the
// query terms (reusing the doc-level idf weights) and return the best-matching one(s),
// so "what are the action items" surfaces the actual action-items paragraph instead of
// the entire email dump.
function extractAnswerSnippet(excerpt: string, queryTerms: string[], idf: (term: string) => number): string {
  const cleaned = stripEmailBoilerplate(excerpt)
  const paragraphs = splitParagraphs(cleaned)
  if (paragraphs.length <= 1) return cleaned || excerpt

  const scored = paragraphs.map((p) => {
    const terms = tokenize(p)
    let score = 0
    for (const qt of queryTerms) {
      const tf = terms.filter((t) => t === qt).length
      if (tf > 0) score += tf * idf(qt)
    }
    return { p, score }
  })

  const best = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score)
  if (best.length === 0) return paragraphs[0]

  return best
    .slice(0, 2)
    .map((s) => s.p)
    .join('\n\n')
}

export interface SearchResult {
  doc: KnowledgeDocRow
  projectName: string
  score: number
  // 'keyword' = matched the TF-IDF scorer directly; 'graph' = surfaced via Neo4j Aura because
  // it shares a project/meeting (or a meeting attendee) with a keyword-matched document, not
  // because its own text matched the query. See graph.ts's expandRelatedDocuments().
  via: 'keyword' | 'graph'
}

interface Index {
  corpus: { doc: KnowledgeDocRow; projectName: string; terms: string[] }[]
  idf: (term: string) => number
}

async function buildIndex(orgId: string): Promise<Index> {
  const { rows } = await pool.query(
    `SELECT kd.*, p.name AS project_name
     FROM knowledge_documents kd
     LEFT JOIN projects p ON p.id = kd.project_id
     WHERE kd.org_id = $1 AND kd.deleted_at IS NULL`,
    [orgId],
  )

  const corpus = (rows as (KnowledgeDocRow & { project_name: string | null })[]).map((doc) => ({
    doc,
    projectName: doc.project_name ?? '',
    terms: tokenize(docText(doc, doc.project_name ?? '')),
  }))

  const docFrequency = new Map<string, number>()
  for (const { terms } of corpus) {
    for (const term of new Set(terms)) {
      docFrequency.set(term, (docFrequency.get(term) ?? 0) + 1)
    }
  }
  const totalDocs = corpus.length || 1
  const idf = (term: string) => Math.log((totalDocs + 1) / ((docFrequency.get(term) ?? 0) + 1)) + 1

  return { corpus, idf }
}

function scoreIndex(index: Index, query: string, topK: number): SearchResult[] {
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return []

  const results: SearchResult[] = index.corpus.map(({ doc, projectName, terms }) => {
    let score = 0
    for (const qt of queryTerms) {
      const tf = terms.filter((t) => t === qt).length
      if (tf > 0) score += tf * index.idf(qt)
    }
    return { doc, projectName, score, via: 'keyword' }
  })

  return results
    .filter((r) => r.score >= MIN_ANSWER_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

export async function searchOrgKnowledge(orgId: string, query: string, topK = 2): Promise<SearchResult[]> {
  const index = await buildIndex(orgId)
  return scoreIndex(index, query, topK)
}

export interface KeywordSearchResult {
  doc: KnowledgeDocRow
  projectName: string
  snippet: string
}

// Backs the chat agent's search_documents tool (see chatTools.ts, chatAgent.ts) — the model
// calls this for open-ended "what was discussed" style questions it can't answer from the
// structured find_* tools. Returns the best-matching paragraph per document, not the whole
// (often thousand-character forwarded-email) excerpt, so the model isn't fed a wall of text
// for a question about one specific thing.
export async function keywordSearchDocuments(orgId: string, query: string, topK = 2): Promise<KeywordSearchResult[]> {
  const index = await buildIndex(orgId)
  const results = scoreIndex(index, query, topK)
  const queryTerms = tokenize(query)
  return results.map((r) => ({
    doc: r.doc,
    projectName: r.projectName,
    snippet: extractAnswerSnippet(r.doc.excerpt, queryTerms, index.idf),
  }))
}
