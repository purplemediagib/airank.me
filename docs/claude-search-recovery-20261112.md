# Claude bounded search recovery, 12 November 2026

The investigated failures finished normally below the output-token allowance but included web-search tool errors. Previous diagnostics collapsed the exact search error into `non_retryable_search_error`; this patch preserves safe error codes to distinguish budget exhaustion from temporary failures.

Tracked, monetarily reserved Claude requests now allow five searches rather than three. Both the first sequence and the existing optional recovery sequence reserve their full limits, including possible pause-turn continuations. Legacy unreserved and guest plans retain three searches. Output/model/timeout/daily-budget settings are unchanged. Actual charges can increase; reservations are not actual billed cost and the $0.10 instruction is not a hard cap.

The Claude-specific prompt asks for planned searches, reuse of successful evidence, concise completion and an explicit marker for uncovered categories. The marker is removed from displayed answer text and flags the result incomplete; it is not a separate paid validator. This self-report does not independently verify completeness. Existing strict tool-error and citation rules remain: answers with a search error or inadequate grounding are never promoted into headline success merely because text exists.

Known tool errors are recorded through a fixed allowlist. Temporary internal/unavailable/too-many-requests errors are eligible for the already bounded single recovery attempt. Search budget exhaustion and unknown/permanent errors are not retried blindly. Lease/deadline, frozen budget, unsettled-attempt and request-count safeguards remain intact.

No historical answer rewriting, research-study changes, paid test runs or schedule changes are included. Next scheduled collection is needed to assess actual recovery and cost. Rollback: the prior worker image `candidate-sha-d42898130a62b0fad51aa6d06b2072a91eb5299a` preserves the Gemini/Kimi fixes.
