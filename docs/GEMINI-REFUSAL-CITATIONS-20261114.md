# Gemini non-answer and citation normalization

Prospective local patch based on deployed country-snapshot tree 25733845d31698ecf33fe26ec74b5e8be3a32860 (remote revision 117518bcd40e3e63658670dcb3ba44c2d2b30ee0). No deployment or data rewrite.

- A complete known Finnish or English Gemini safety-refusal template becomes provider_failed with PROVIDER_REFUSAL. Substantive prose mentioning or quoting safety/refusal remains an answer. This is intentionally a narrow deterministic detector, not universal multilingual refusal detection.
- The collector finalizes the existing result; it does not retry a refusal. Non-success evidence is excluded by existing metric eligibility rules.
- Gemini gemini_text passage Markdown links count only when the safe HTTP(S) URL also appears in that same item's sources and the label matches its domain. Ordinary root links, unmatched links and generic source lists are not promoted. Source-reference provenance is retained separately; metric citation URLs are deduplicated.
- Without observable attached citations, existing DataForSEO citationObservation remains unavailable rather than claiming zero observed citations.
- The provider contract is illustrated at https://docs.dataforseo.com/v3/ai_optimization/gemini/llm_scraper/task_get/advanced/ . Fixtures are synthetic.

Historical saved evidence is unchanged. Read-time reclassification would need coordinated Results SQL filters/history counts, detail state and analytics changes; this patch does not claim those are corrected. The front end must distinguish unavailable attribution from an observed zero, and keep Other sources separate from Citations.
