import {promptContext} from './common.mjs';
export const isMistral=model=>/^mistralai\//.test(model);
export const openrouterPrompt=(prompt,context,model)=>promptContext(prompt,context)+' Include source citations.'+
 (isMistral(model)?' Keep the answer under about 600 words.':'');
export const openrouterSearchLimits=model=>isMistral(model)
 ?{max_uses:2,max_results:3,max_total_results:6}
 :{max_uses:3,max_results:5,max_total_results:15};
