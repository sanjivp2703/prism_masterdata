// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const LLM_MODEL_ID = 'claude-haiku-4-5-20251001' as const;

// ---------------------------------------------------------------------------
// Response schema (matches the JSON the prompt asks the model to emit)
// ---------------------------------------------------------------------------

export type LLMConfidenceResponse = {
  match: boolean;
  confidence: number;
  reasoning: string | null;
  flags: string[];
  deterministic_assessment: {
    model_agrees_with_baseline: boolean;
    disagreement_direction: 'agree' | 'model_higher' | 'model_lower';
  };
};

// Loose feature payload type — the exact shape is built in apply-confident-assignments.
// Typed as unknown here so this module has no dependency on the scoring internals.
export type FeaturePayload = Record<string, unknown>;

// ---------------------------------------------------------------------------
// System prompt template
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_TEMPLATE = `\
You are a classification assistant for an entity-resolution system.
For each (run_item, candidate_alias) pair, you decide whether the
run item's literal value refers to the candidate alias's entity.

You receive structured features computed by a deterministic pipeline.
The pipeline measures token overlap, string similarity, acronym matches,
exact matches, and per-token rarity within the concept. These features
are factual measurements; use them as evidence.

The pipeline does not have world knowledge. It cannot recognize that
"VZW" is an abbreviation for Verizon, or that "BoA" means Bank of
America. When such cases arise, use your domain knowledge and flag
the response with "domain_knowledge_required".

For the acronym section, use your world knowledge to determine whether
the run_item is an acronym, abbreviation, or shorthand for the candidate
alias -- or vice versa. The deterministic pipeline can only do mechanical
first-letter extraction and will miss cases like "VZW" -> "Verizon Wireless"
or "BoA" -> "Bank of America". Your judgment here supersedes the
deterministic scores shown. Flag with "acronym_decisive" if an acronym
or abbreviation relationship drove your confidence decision.

You also see the full list of other aliases in this concept. The right
answer may be that this run_item belongs to a different alias, in which
case return a low confidence here.

Your output is a confidence value in [0,1] representing the probability
that this run_item matches this candidate alias. Calibration matters --
0.8 should mean ~80% likely correct. Avoid clustering near 0 or 1
unless the evidence is decisive.

Reasoning must reference at least one specific feature value or named
token. If confidence is below 0.05, reasoning may be null.

Respond only in valid JSON matching this schema:
{
  "match": boolean,
  "confidence": number,
  "reasoning": string | null,
  "flags": string[],
  "deterministic_assessment": {
    "model_agrees_with_baseline": boolean,
    "disagreement_direction": "agree" | "model_higher" | "model_lower"
  }
}

---

CONCEPT: {{concept_name}}
DEFINITION: {{concept_definition}}

ALL ALIASES IN THIS CONCEPT:
{{alias_list}}`;

// ---------------------------------------------------------------------------
// Cached system block builder
// ---------------------------------------------------------------------------

// The type for a system message block accepted by the Anthropic SDK.
// Defined locally to avoid importing internal SDK types.
type TextBlockParam = {
  type: 'text';
  text: string;
  cache_control: { type: 'ephemeral' };
};

/**
 * Build the static system block for a run.
 *
 * This block is identical for every (run_item, alias) pair within a run —
 * only the user message (featurePayload) changes per call. Anthropic's
 * prompt-caching layer recognises identical content across requests in the
 * same session and charges ~10 % of normal input-token cost after the first
 * call warms the cache.
 *
 * @param conceptName       The concept's display name (e.g. "Mobile Carrier").
 * @param conceptDefinition The concept's definition text. May be empty string
 *                          if the concept has no stored definition.
 * @param aliasLiteralValues All alias_name.literal_value strings for every
 *                           alias in the run's concept. Order is irrelevant
 *                           but must be consistent across calls in a run so
 *                           the cached block hash is stable.
 */
export function buildCachedSystemBlock(
  conceptName: string,
  conceptDefinition: string,
  aliasLiteralValues: string[],
): TextBlockParam[] {
  const aliasList = aliasLiteralValues.join(', ');
  const text = SYSTEM_PROMPT_TEMPLATE
    .replace('{{concept_name}}', conceptName)
    .replace('{{concept_definition}}', conceptDefinition || '(no definition provided)')
    .replace('{{alias_list}}', aliasList || '(none)');

  return [
    {
      type: 'text',
      text,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

/**
 * Score a single (run_item, candidate_alias) pair using the LLM.
 *
 * Uses raw fetch so the exact headers and body shape match the Anthropic API
 * spec (including anthropic-beta for prompt caching).
 *
 * @param cachedSystemBlock  Built once per run via buildCachedSystemBlock().
 *                           Sent on every call; Anthropic's cache layer
 *                           recognises the identical content and charges
 *                           ~10% of normal input-token cost after the first.
 * @param featurePayload     The per-pair feature object (changes every call,
 *                           never cached). Serialised with 2-space indentation
 *                           so the model reads structured data cleanly.
 * @returns                  Parsed LLMConfidenceResponse.
 * @throws                   On network error, non-200 response, or JSON parse
 *                           failure — the caller is responsible for the
 *                           try/catch and fallback to deterministic score.
 */
export type LLMTokenUsage = {
  /** Tokens billed at full input rate (cache miss). */
  input_tokens: number;
  /** Tokens generated by the model. */
  output_tokens: number;
  /** Input tokens served from the prompt cache (charged at ~10% of input rate). */
  cache_read_input_tokens: number;
  /** Input tokens written into the cache on this call. */
  cache_creation_input_tokens: number;
};

export type ScoredPairResult = {
  parsed: LLMConfidenceResponse;
  /** The raw text returned by the model, before fence stripping. */
  rawText: string;
  /** Token counts as reported by the Anthropic API for this call. */
  usage: LLMTokenUsage;
  /**
   * Wall-clock milliseconds from just before the HTTP request was sent to
   * just after the response JSON was fully parsed.  Does NOT include
   * pre-filter checks, Redis cache lookups, or retry back-off sleep.
   */
  llm_call_ms: number;
};

export async function scorePairWithLLM(
  cachedSystemBlock: ReturnType<typeof buildCachedSystemBlock>,
  featurePayload: FeaturePayload,
): Promise<ScoredPairResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('[llm-confidence] ANTHROPIC_API_KEY environment variable is not set.');

  const llmCallStart = Date.now();

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model: LLM_MODEL_ID,
      max_tokens: 1024,
      system: cachedSystemBlock,
      messages: [
        {
          role: 'user',
          content: JSON.stringify(featurePayload, null, 2),
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    const apiErr = new Error(`[llm-confidence] Anthropic API ${res.status}: ${body}`);
    (apiErr as Error & { status: number }).status = res.status;
    throw apiErr;
  }

  const data = await res.json() as {
    content?: Array<{ type: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  const textBlock = data.content?.find((b) => b.type === 'text');
  if (!textBlock?.text) {
    throw new Error(`[llm-confidence] No text block in response: ${JSON.stringify(data)}`);
  }

  // The model sometimes wraps output in markdown code fences AND appends free-text
  // explanations after the closing fence. Strategy:
  //   1. If there is a ```json … ``` fence, extract only the content inside it.
  //   2. Otherwise strip all fences and extract the substring from the first `{`
  //      to the last `}` to discard any trailing prose.
  const raw = textBlock.text;

  let cleaned: string;
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  } else {
    const stripped = raw.replace(/```json\n?/g, '').replace(/```/g, '');
    const firstBrace = stripped.indexOf('{');
    const lastBrace = stripped.lastIndexOf('}');
    cleaned = firstBrace !== -1 && lastBrace > firstBrace
      ? stripped.slice(firstBrace, lastBrace + 1)
      : stripped.trim();
  }

  const usage: LLMTokenUsage = {
    input_tokens:                  data.usage?.input_tokens                  ?? 0,
    output_tokens:                 data.usage?.output_tokens                 ?? 0,
    cache_read_input_tokens:       data.usage?.cache_read_input_tokens       ?? 0,
    cache_creation_input_tokens:   data.usage?.cache_creation_input_tokens   ?? 0,
  };

  try {
    const parsed = JSON.parse(cleaned) as LLMConfidenceResponse;
    return { parsed, rawText: raw, usage, llm_call_ms: Date.now() - llmCallStart };
  } catch {
    throw new Error(`[llm-confidence] Failed to parse LLM JSON: ${raw}`);
  }
}
