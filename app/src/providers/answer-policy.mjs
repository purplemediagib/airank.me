// A request for economical generation, not a provider-enforced spending cap.
// Keep this version in evidence for an explicitly separated trial comparison.
export const answerPromptPolicyVersion='complete-economical-answer-v1';
export const answerCostTargetUsd=0.10;
export const answerCostInstruction='Aim to keep the total cost of this complete answer below $0.10 USD, including input, reasoning, output and any search or tool use. Use only the research needed to answer the question accurately, avoid redundant searches and repetition, and give a concise but complete answer. Cover every material part of the question, retain necessary facts and source citations, and clearly state uncertainty. Do not omit essential information, invent evidence or present a partial answer as complete to meet the cost target. Do not discuss the cost target in the answer.';
export const answerPromptMeta=()=>({prompt_policy:answerPromptPolicyVersion,answer_cost_target_usd:answerCostTargetUsd});
