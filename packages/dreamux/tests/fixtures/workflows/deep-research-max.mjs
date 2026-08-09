export const meta = {
  name: 'deep-research-max',
  description: 'Fan-out web research, fetch sources, adversarially verify claims, synthesize a cited report',
  whenToUse: 'Deep, multi-source, fact-checked research on a refined question passed as args.question',
  phases: [
    { title: 'Scope', detail: 'decompose the question into complementary search angles' },
    { title: 'Search', detail: 'one web-search agent per angle' },
    { title: 'Fetch', detail: 'dedup URLs, fetch top sources, extract falsifiable claims' },
    { title: 'Verify', detail: '3-vote adversarial verification per claim' },
    { title: 'Synthesize', detail: 'merge, rank by confidence, cite; critic + one gap-fill round' },
  ],
}

const question = args && args.question
if (!question) return { error: 'args.question is required' }
const ANGLES = (args && args.angles) || 5
const MAX_SOURCES = (args && args.maxSources) || 15

const SOURCES_SCHEMA = {
  type: 'object',
  properties: {
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['url', 'title'],
        additionalProperties: false,
      },
    },
  },
  required: ['sources'],
  additionalProperties: false,
}

const CLAIMS_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'a single falsifiable factual claim' },
          quote: { type: 'string', description: 'the supporting quote from the source' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  required: ['claims'],
  additionalProperties: false,
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reasoning: { type: 'string' },
    counterSource: { type: 'string' },
  },
  required: ['refuted', 'reasoning'],
  additionalProperties: false,
}

// 3-vote adversarial verification; a claim survives unless >=2 of 3 skeptics refute it
function verifyClaim(claim, sourceUrl, tag) {
  return parallel([0, 1, 2].map((v) => () =>
    agent(
      `You are skeptic #${v + 1}. Try to REFUTE this claim using independent web sources:\n` +
      `"${claim.text}"\n(originally from ${sourceUrl})\n` +
      `Search for counter-evidence and primary sources. Default to refuted=true if you ` +
      `cannot independently corroborate it.`,
      { label: `verify:${tag}:v${v + 1}`, phase: 'Verify', schema: VERDICT_SCHEMA },
    ),
  )).then((votes) => {
    const ok = votes.filter(Boolean)
    const refutes = ok.filter((x) => x.refuted).length
    return {
      text: claim.text,
      quote: claim.quote || '',
      source: sourceUrl,
      votes: ok.length,
      refutes,
      survives: ok.length > 0 && refutes < 2,
    }
  })
}

phase('Scope')
const scope = await agent(
  `Decompose this research question into ${ANGLES} complementary search angles ` +
  `(distinct sub-questions or search strategies that together cover the topic):\n${question}`,
  {
    label: 'scope',
    phase: 'Scope',
    schema: {
      type: 'object',
      properties: {
        angles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              queries: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'queries'],
            additionalProperties: false,
          },
        },
      },
      required: ['angles'],
      additionalProperties: false,
    },
  },
)
if (!scope || !scope.angles || !scope.angles.length) return { error: 'scoping failed' }

phase('Search')
// barrier is justified here: URL-level dedup below needs every angle's results at once
const searchResults = await parallel(scope.angles.slice(0, ANGLES).map((a, i) => () =>
  agent(
    `Research angle "${a.name}" for the question: ${question}\n` +
    `Run web searches for: ${a.queries.join(' | ')}\n` +
    `Return the 5-8 most authoritative candidate sources (prefer primary sources).`,
    { label: `search:${i}:${a.name}`, phase: 'Search', schema: SOURCES_SCHEMA },
  ),
))

const seenUrl = new Set()
const sources = []
for (const r of searchResults.filter(Boolean)) {
  for (const s of r.sources) {
    const key = s.url.replace(/[#?].*$/, '').replace(/\/$/, '')
    if (!seenUrl.has(key)) { seenUrl.add(key); sources.push(s) }
  }
}
const top = sources.slice(0, MAX_SOURCES)
log(`${sources.length} unique sources across ${ANGLES} angles; fetching top ${top.length}`)

// Fetch -> Verify as a pipeline: each source advances to verification independently,
// no barrier between the two stages. Stage 2 uses the 3-arg (prev, originalItem, index) form.
const perSource = await pipeline(
  top,
  (src) => agent(
    `Fetch ${src.url} ("${src.title}") and extract up to 5 falsifiable claims that bear ` +
    `directly on: ${question}\nOnly claims actually supported by the page content.`,
    { label: `fetch:${src.title.slice(0, 30)}`, phase: 'Fetch', schema: CLAIMS_SCHEMA },
  ),
  (extracted, src, idx) => {
    if (!extracted || !extracted.claims.length) return { source: src.url, claims: [] }
    return parallel(extracted.claims.map((c, ci) => () => verifyClaim(c, src.url, `${idx}.${ci}`)))
      .then((claims) => ({ source: src.url, claims: claims.filter(Boolean) }))
  },
)

const surviving = perSource.filter(Boolean).flatMap((s) => s.claims.filter((c) => c.survives))
log(`${surviving.length} claims survived 3-vote adversarial verification`)

phase('Synthesize')
const draft = await agent(
  `Write a research report answering: ${question}\n` +
  `Use ONLY these verified claims (JSON):\n${JSON.stringify(surviving)}\n` +
  `Merge semantic duplicates, order sections by confidence (fewer refute votes first), ` +
  `cite source URLs inline after each claim. Return the report as markdown.`,
  { label: 'synthesize', phase: 'Synthesize' },
)

// completeness critic + one gap-fill round
const critic = await agent(
  `Question: ${question}\nDraft report:\n${draft}\n` +
  `List up to 3 concrete gaps: sub-questions the report leaves unanswered or ` +
  `one-source-only areas needing corroboration. Empty list if none.`,
  {
    label: 'critic',
    phase: 'Synthesize',
    schema: {
      type: 'object',
      properties: { gaps: { type: 'array', items: { type: 'string' } } },
      required: ['gaps'],
      additionalProperties: false,
    },
  },
)

let report = draft
const gaps = (critic && critic.gaps) || []
if (gaps.length) {
  log(`critic found ${gaps.length} gaps; running one gap-fill round`)
  const gapClaims = await pipeline(
    gaps,
    (gap) => agent(
      `Targeted research: ${gap}\n(parent question: ${question})\n` +
      `Search, read the best 2-3 sources, and extract falsifiable claims with source URLs ` +
      `in the quote field as "claim -- URL".`,
      { phase: 'Verify', schema: CLAIMS_SCHEMA },
    ),
    (extracted, gap, gi) => {
      if (!extracted || !extracted.claims.length) return []
      return parallel(extracted.claims.map((c, ci) => () => verifyClaim(c, `gap:${gap}`, `g${gi}.${ci}`)))
        .then((cs) => cs.filter(Boolean).filter((c) => c.survives))
    },
  )
  const extra = gapClaims.filter(Boolean).flat()
  if (extra.length) {
    report = await agent(
      `Revise this report to close the listed gaps using the new verified claims.\n` +
      `Report:\n${draft}\nGaps: ${JSON.stringify(gaps)}\n` +
      `New verified claims: ${JSON.stringify(extra)}\nReturn the full revised markdown.`,
      { label: 'revise', phase: 'Synthesize' },
    )
    surviving.push(...extra)
  }
}

return { question, report, claimCount: surviving.length, gaps }
