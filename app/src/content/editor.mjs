import {fail,hash} from './store.mjs';
export function documentInput(b){
 if(!b||!['fi','en'].includes(b.locale)||typeof b.title!=='string'||b.title.length>300||typeof b.markdown!=='string'||b.markdown.length>100000)fail(422,'INVALID_DOCUMENT');
 if(b.description!==undefined&&(typeof b.description!=='string'||b.description.length>1000))fail(422,'INVALID_DESCRIPTION');
 return {title:b.title,markdown:b.markdown,description:b.description||'',locale:b.locale,status:'draft',sourceUrl:b.sourceUrl||null,topic:b.topic||'',expertise:b.expertise||'',contentHash:hash(b.markdown),reviewedClaims:false};
}
export function applyChanges(markdown,changes,ids){
 if(!Array.isArray(ids)||new Set(ids).size!==ids.length)fail(422,'INVALID_CHANGE_SELECTION');
 const selected=ids.map(id=>{const c=changes.find(c=>c.id===id);if(!c)fail(422,'UNKNOWN_CHANGE');return c;});
 // Anchor against original source, not a previous replacement. Reject overlaps and ambiguous anchors.
 const patches=selected.map(c=>{if(!c.original)fail(422,'EMPTY_CHANGE_ANCHOR');const at=markdown.indexOf(c.original);if(at<0||markdown.indexOf(c.original,at+1)>=0)fail(409,'CHANGE_ANCHOR_CONFLICT');return {...c,at,end:at+c.original.length};}).sort((a,b)=>a.at-b.at);
 for(let i=1;i<patches.length;i++)if(patches[i].at<patches[i-1].end)fail(409,'OVERLAPPING_CHANGES');
 for(const p of patches.reverse())markdown=markdown.slice(0,p.at)+p.replacement+markdown.slice(p.end);return markdown;
}
export const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function inline(s){return escape(s).replace(/!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)/g,(_m,t,u)=>`<img src="${u}" alt="${t}" loading="lazy">`).replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g,(_m,t,u)=>`<a href="${u}" rel="noopener noreferrer">${t}</a>`).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<code>$1</code>');}
// Deliberately small, escaped Markdown dialect: no arbitrary raw HTML.
export function toHtml(md){let out=[],list=false,table=false,head=false;for(const line of md.split('\n')){const h=line.match(/^(#{1,6})\s+(.*)/),li=line.match(/^[-*]\s+(.*)/),row=/^\s*\|.*\|\s*$/.test(line);if(list&&!li){out.push('</ul>');list=false;}if(table&&!row){out.push('</tbody></table>');table=false;}if(row){if(/^\s*\|[\s|:-]+\|\s*$/.test(line))continue;if(!table){out.push('<table><tbody>');table=true;head=true;}const tag=head?'th':'td';out.push('<tr>'+line.trim().slice(1,-1).split('|').map(c=>`<${tag}>${inline(c.trim())}</${tag}>`).join('')+'</tr>');head=false;}else if(h)out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);else if(li){if(!list){out.push('<ul>');list=true;}out.push(`<li>${inline(li[1])}</li>`);}else if(line.trim())out.push(`<p>${inline(line)}</p>`);}if(list)out.push('</ul>');if(table)out.push('</tbody></table>');return out.join('\n');}
export function exportsFor(doc){return {markdown:doc.markdown,html:toHtml(doc.markdown),plainText:doc.markdown.replace(/^#{1,6}\s+/gm,'').replace(/\*\*/g,''),title:doc.title,description:doc.description,
 structuredDataSuggestion:{'@context':'https://schema.org','@type':'Article',headline:doc.title,inLanguage:doc.locale,...(doc.sourceUrl?{url:doc.sourceUrl}:{}),description:doc.description},
 note:'Structured data is a suggestion; verify author, publisher and dates before adding them. It does not guarantee citations.'};}
