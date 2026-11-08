# Complete-answer cost target

Development change only. No provider settings, model pins, customer questions,
database records, scheduler, migrations, deployment or paid requests are changed
by this patch.

## Prompt scope

The shared generative API wrapper requests a total answer cost below **$0.10 USD**
including input, reasoning, output and search/tools. It asks for a concise,
complete answer with necessary facts and sources, and explicitly forbids omitting
essential information or presenting a partial answer as complete to meet the
target. It does not add a smaller token cap or change model selection.

This covers direct OpenAI, Claude, Grok and Perplexity adapters, the legacy direct
Gemini adapter, and all configured OpenRouter models (including Grok, Gemini,
Meta AI, DeepSeek, Mistral and Kimi). The same wrapper is used for API-based guest
checks and benchmark requests. Existing input-byte admission checks include the
new instruction. Model IDs in offline test fixtures do not assert availability.

Consumer ChatGPT/Gemini/Perplexity/Grok collectors continue submitting the
customer's exact original question. Their supplier's collection fee cannot be
reduced by a billing request to the consumer chatbot. Google AI Overviews is a
SERP collection, not a generative-model prompt. Do not append this instruction
to search keywords or represent API results as consumer-product observations.

Returned adapter responses retain `prompt_policy` and
`answer_cost_target_usd` in evidence for the isolated trial. Existing dashboard
grouping and historical evidence are unchanged. Trial analysis must explicitly
separate prompt-policy versions. Before a production rollout, decide how to
mark the intervention in historical comparisons; the existing dashboard does
not automatically separate these versions. Transport errors may have no policy
tag, so the trial's own pre-dispatch manifest must record the intended policy.

Scope is tracking answers, not auxiliary LLM tasks such as content generation,
sentiment/extraction, website profiling or question suggestions. Those have
different structured-output/completeness contracts and are not benchmark arms.

## What the target does and does not mean

The instruction is an efficiency target, **not a billing cap**. Models may not
know their provider's rates, search fan-out, hidden reasoning or billed usage.
Existing output limits, route-specific price ceilings and completion validation
remain in place. Truncated, refused or unfinished answers remain failed or
incomplete even if cheap. There is no new retry, continuation or cheaper-model
fallback. Existing Claude bounded continuation behavior is unchanged.

The current API reservation mechanism is conditional on configured prices,
context ceilings and search counts actually being enforced. OpenRouter's
requested `max_uses`/`max_tool_calls` must not be treated as a proven billable
search ceiling. Existing provider-reported Grok usage exceeded the requested
search count. Reducing output tokens alone does not control that cost and may
increase incomplete answers. A strict per-answer dollar admission rule based
on a full-context worst case would reject many useful requests rather than
guaranteeing a complete answer under ten cents.

## Isolated comparison and $5 authorization

Do not run the production monitoring queue or enable benchmark scheduling for
this trial. The existing benchmark runner has call counts, not a sufficient
verified $5 monetary bound. Use a separate test runtime, output files and spend
ledger. Never infer live credentials from a source checkout.

Before any paid call, verify the supplier/model/route and enforceable maximum
billable usage or a dedicated provider-enforced total spend limit. Reserve the
maximum cost against the single **$5 total** authorization before dispatch,
including continuations, retries, searches, collector charges and ambiguous
outcomes. Do not refund an uncertain call or issue it again automatically.
Missing bounds or credentials mean the paid trial remains blocked, not passed.

Start with two identical Finnish questions per eligible route, including Grok
4.7 and a separate Grok 4.3 low-reasoning/native-search candidate if available.
Expand only when the remaining reserved budget allows. Preserve each actual
route, prompt-policy version, answer, completion reason, brand mentions,
citations and provider-reported cost. Compare complete answers per dollar as
well as mean/p95 cost and failure rate. Mark absent cost as unknown, never zero.
Collector charges and model generation charges are different measures.

Baseline repricing is a scenario calculation, not a new-model experiment.
Offline tests validate request construction and completion behavior, not answer
quality, price savings, invoice totals or consumer-product fidelity.
