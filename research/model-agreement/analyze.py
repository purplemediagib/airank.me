"""Offline analysis of human-reviewed observations; never extracts/invents entities."""
import collections,itertools,json,sys
from urllib.parse import urlsplit
ENDPOINTS={'openai_api','kimi_api','claude_api'}

def host(url):
    p=urlsplit(url)
    if p.scheme not in ('http','https') or p.username or p.password or not p.hostname:return None
    return p.hostname.lower().rstrip('.')

def owned_citation(url,domains):
    h=host(url)
    if not h:return False
    return any(h==d.lower().rstrip('.') or h.endswith('.'+d.lower().rstrip('.')) for d in domains if d and '/' not in d and ':' not in d)

def jaccard(a,b):
    union=a|b
    return len(a&b)/len(union) if union else None

def analyze(observations,registry,max_span=600):
    groups=collections.defaultdict(list);coverage=collections.Counter();pair_values=collections.defaultdict(list);citation=collections.Counter();by_prompt=collections.defaultdict(list)
    seen=set()
    for r in observations:
        key=(r['comparison_group'],r['endpoint'])
        if key in seen:raise ValueError('Duplicate endpoint observation; resolve attempts explicitly first')
        seen.add(key);groups[r['comparison_group']].append(r)
    for group,rows in groups.items():
        if len(rows)!=3 or {r['endpoint'] for r in rows}!=ENDPOINTS:coverage['missing_endpoint_groups']+=1;continue
        if len({r['prompt_id'] for r in rows})!=1:raise ValueError('Mismatched prompts')
        if any(r.get('status')!='complete' for r in rows):coverage['failed_or_incomplete_groups']+=1;continue
        if any(r.get('reviewed') is not True for r in rows):coverage['unreviewed_groups']+=1;continue
        if any(b.get('recommended') is None for r in rows for b in r.get('brands',[])):coverage['ambiguous_recommendation_groups']+=1;continue
        if max(r['ended_at_epoch'] for r in rows)-min(r['started_at_epoch'] for r in rows)>max_span:coverage['late_groups']+=1;continue
        checked=[]
        for r in rows:
            brands=r.get('brands',[])
            if len({b['entity_id'] for b in brands})!=len(brands):raise ValueError('Duplicate entity in answer')
            for b in brands:
                entity=registry.get(b['entity_id'])
                if not entity or entity.get('reviewed') is not True or not entity.get('ownership_source'):raise ValueError('Entity/domain ownership not verified')
                if b.get('mention_present') not in (True,False) or b.get('recommended') not in (True,False,None):raise ValueError('Explicit coding required')
                if b.get('mention_present'):
                    if not b.get('supporting_text_span'):raise ValueError('Mention needs supporting text')
                    citation['reviewed_brand_mentions']+=1
                    # Only explicitly saved answer citations count; retrieved sources must not be placed here.
                    found=any(owned_citation(u,entity['owned_domains']) for u in r.get('explicit_citation_urls',[]))
                    citation['mentions_with_owned_domain_citation' if found else 'mentions_without_owned_domain_citation']+=1
                if b.get('recommended') is True and b.get('mention_present') is not True:raise ValueError('Recommendation requires mention')
            checked.append((r['endpoint'],{b['entity_id'] for b in brands if b.get('recommended') is True}))
        coverage['eligible_groups']+=1
        for (ea,a),(eb,b) in itertools.combinations(sorted(checked),2):
            pair=ea+' vs '+eb;v=jaccard(a,b)
            if v is None:coverage['both_empty_pairs']+=1;continue
            pair_values[pair].append(v);by_prompt[(pair,rows[0]['prompt_id'])].append(v)
    output={}
    for pair,values in pair_values.items():
        means=[sum(v)/len(v) for (p,_),v in by_prompt.items() if p==pair]
        output[pair]={'eligible_nonempty_pairs':len(values),'contributing_prompts':len(means),'prompt_macro_jaccard':sum(means)/len(means)}
    return {'coverage':dict(coverage),'comparison':output,'citations':dict(citation),'limitations':['Complete reviewed triples only; excludes failed and late groups, counts shown.','Empty-empty recommendation sets are undefined, not perfect agreement.','Owned-domain citation anywhere in answer is not proof citation supports the brand claim.','No causal inference, consumer-UI equivalence or national representativeness.']}

if __name__=='__main__':
    data=json.load(open(sys.argv[1]));print(json.dumps(analyze(data['observations'],data['registry']),indent=2))
