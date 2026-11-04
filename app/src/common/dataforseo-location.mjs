// Only select a market actually present in this endpoint's supplier catalogue.
// Google SERP lists Gibraltar as a top-level Region, not Country. Keep this
// verified exception exact: a general Region fallback could select a subregion.
// Source: https://cdn.dataforseo.com/v3/locations/locations_serp_google_2026_09_01.csv
const territories={GI:{location_code:2292,location_name:'Gibraltar',location_type:'Region'}};

export function selectMarketLocation(market,locations){
 if(!Array.isArray(locations))return null;
 const territory=territories[market];
 const matches=locations.filter(x=>{
  if(!x||x.country_iso_code!==market||!Number.isSafeInteger(x.location_code)||x.location_code<=0)return false;
  if(x.location_type==='Country')return x.location_code_parent===undefined||x.location_code_parent===null;
  return !!territory&&x.location_code_parent===null&&x.location_code===territory.location_code&&x.location_name===territory.location_name&&x.location_type===territory.location_type;
 });
 // Never pick an arbitrary row if the supplier reports ambiguous market roots.
 return matches.length===1?matches[0]:null;
}
