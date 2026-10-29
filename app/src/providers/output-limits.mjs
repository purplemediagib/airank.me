// The HTTP adapter and monetary reservation must use the same default.
export const openrouterDefaultOutputTokens=model=>
 /^mistralai\//.test(model)?12000:
 /^deepseek\//.test(model)?4096:
 /^(google\/gemini-|moonshotai\/kimi|x-ai\/grok)/.test(model)?8192:4000;
