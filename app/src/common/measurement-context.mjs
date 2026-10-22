// ISO 3166-1 markets and ISO 639-1 requested languages, independent of UI locale.
const countries='AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const tongues='aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu'.split(' ');
const regions=new Intl.DisplayNames(['en'],{type:'region'}),languages=new Intl.DisplayNames(['en'],{type:'language'});
export function measurementContext(value={}){
 const market=value.market??'FI',language=value.promptLanguage??value.language??'fi';
 if(market==='RU')throw Object.assign(Error('MARKET_EXCLUDED'),{status:422,code:'MARKET_EXCLUDED'});
 if(!countries.includes(market)||!tongues.includes(language))throw Object.assign(Error('INVALID_MEASUREMENT_CONTEXT'),{status:422,code:'INVALID_MEASUREMENT_CONTEXT'});
 return {market,language};
}
export function sameContext(a,b){const x=measurementContext(a),y=measurementContext(b);return x.market===y.market&&x.language===y.language;}
export function contextCatalog(){return{
 markets:countries.filter(c=>c!=='RU').map(code=>({code,name:regions.of(code)})),
 languages:tongues.map(code=>({code,name:languages.of(code)})),
 excludedMarkets:['RU'],
 notice:'Market and language are requested model context, not a guarantee of local search coverage or language quality. Provider account/service availability is separate. Review generated questions before measurement.'
};}
export function contextInstruction(value){
 const {market,language}=measurementContext(value);
 return `Answer exclusively in ${languages.of(language)} (${language}). Compare real providers/products available to customers in ${regions.of(market)} (${market}). Use web search when available. Separate verified facts from uncertainty. Do not invent businesses, websites or sources. This is requested market context, not proof of geographic search targeting.`;
}
