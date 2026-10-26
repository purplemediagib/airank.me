// The HTTP adapter and monetary reservation must use the same default.
export const openrouterDefaultOutputTokens=model=>
 /^(google\/gemini-|moonshotai\/kimi|deepseek\/)/.test(model)?8192:4000;
