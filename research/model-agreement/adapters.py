"""Explicit provider adapters. Network only from an authorized invocation."""
import copy,json,socket,re
from decimal import Decimal,ROUND_CEILING
from urllib.request import Request,build_opener,HTTPRedirectHandler
from urllib.error import HTTPError,URLError
from core import sanitize
URLS={'openai_api':'https://api.openai.com/v1/responses','kimi_api':'https://openrouter.ai/api/v1/chat/completions','claude_api':'https://api.anthropic.com/v1/messages'}
KEYS={'openai_api':'OPENAI_API_KEY','kimi_api':'OPENROUTER_API_KEY','claude_api':'ANTHROPIC_API_KEY'}
SYSTEM="Respond to the user's purchasing question. Do not invent businesses, sources or capabilities. Use the configured search tool when available. Follow the requested answer language."
class ProviderError(Exception):
    def __init__(self,category,retry_after=60):self.category=category;self.retry_after=retry_after;super().__init__(category)
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ProviderError('redirect_forbidden')

def http(ep,body,key,timeout):
    headers={'Content-Type':'application/json'}
    if ep=='claude_api':headers.update({'x-api-key':key,'anthropic-version':'2023-06-01'})
    else:headers['Authorization']='Bearer '+key
    req=Request(URLS[ep],json.dumps(body).encode(),headers,method='POST')
    try:
        with build_opener(NoRedirect).open(req,timeout=timeout) as r:return json.load(r)
    except HTTPError as e:
        try:wait=max(60,float(e.headers.get('Retry-After','60')))
        except (TypeError,ValueError):wait=60
        raise ProviderError('429' if e.code==429 else '5xx' if e.code>=500 else 'http_'+str(e.code),wait) from None
    except (URLError,TimeoutError,socket.timeout):raise ProviderError('timeout') from None
    except (ValueError,UnicodeDecodeError):raise ProviderError('invalid_response') from None

def reservation_bound(c):
    """Arithmetic verification only: reviewed unit ceilings/prices need external evidence."""
    if c.get('guard_mode')=='account_operational':
        if c.get('account_guard_reviewed') is not True or not c.get('account_guard_evidence') or c.get('bound_verified') is not False or c.get('account_cap_micro_usd')!=5000000 or c.get('overshoot_reserve_micro_usd')!=5000000 or c.get('reservation_micro_usd')!=10000000:raise RuntimeError('Invalid operational account guard')
        return 10000000  # Operational exposure allowance, NOT a proven request-cost bound.
    if c.get('bound_verified') is not True or not c.get('bound_evidence') or c.get('billing_units_reviewed') is not True:raise RuntimeError('Unreviewed reservation derivation')
    price=c['price']
    input_rate=max(Decimal(str(price[k])) for k in ('input_per_million','cache_write_per_million','cache_read_per_million') if k in price)
    output_rate=Decimal(str(price['output_per_million']));search_rate=Decimal(str(price['search_per_call']))
    extra=Decimal(str(c['verified_extra_cost_usd']))
    if any(not v.is_finite() or v<0 for v in (input_rate,output_rate,search_rate,extra)):raise RuntimeError('Invalid reviewed rates')
    ceilings=[c[k] for k in ('verified_max_total_input_tokens','verified_max_total_output_tokens','verified_max_search_calls')]
    if any(type(v)!=int or v<0 for v in ceilings):raise RuntimeError('Invalid unit ceiling')
    cost=Decimal(ceilings[0])*input_rate/1000000+Decimal(ceilings[1])*output_rate/1000000+Decimal(ceilings[2])*search_rate+extra
    result=micro(cost)
    if result>c['reservation_micro_usd']:raise RuntimeError('Reservation below reviewed derivation')
    return result

def request(ep,prompt,c,key,transport=http):
    if not key:raise RuntimeError('Missing provider credential')
    reservation_bound(c)
    params=copy.deepcopy(c['request_parameters'])
    if any(k in params for k in ('input','messages','model','instructions','system','stream','previous_response_id','background','store')):raise RuntimeError('Reserved request field')
    # Fully reviewed request body: no hidden SDK retries or fallback routes.
    if ep=='openai_api':
        if not 0<params.get('max_output_tokens',0)<=c['verified_max_output_tokens'] or not 0<params.get('max_tool_calls',0)<=c['verified_max_search_calls']:raise RuntimeError('OpenAI request caps differ')
        body={**params,'model':c['model'],'instructions':SYSTEM,'input':prompt,'store':False,'stream':False}
    elif ep=='kimi_api':
        if not 0<params.get('max_tokens',0)<=c['verified_max_output_tokens'] or 'provider' in params:raise RuntimeError('Kimi request cap/provider differs')
        plugins=params.get('plugins',[])
        if len(plugins)!=1 or plugins[0].get('id')!='web' or plugins[0].get('engine')!='exa' or type(plugins[0].get('max_results'))!=int or not 0<plugins[0]['max_results']<=c.get('verified_max_search_results',0):raise RuntimeError('Kimi Exa route/bounds differ')
        if any(k not in ('id','engine','max_results') for k in plugins[0]) or params.get('tools') or params.get('models') or params.get('route') or params.get('n',1)!=1:raise RuntimeError('Unapproved Kimi routing/tools')
        if not c.get('provider') or c['provider'] not in c['allowed_providers']:raise RuntimeError('Kimi provider pin unapproved')
        body={**params,'model':c['model'],'messages':[{'role':'system','content':SYSTEM},{'role':'user','content':prompt}],'provider':{'only':[c['provider']],'allow_fallbacks':False,'require_parameters':True},'stream':False}
    elif ep=='claude_api':
        if not 0<params.get('max_tokens',0)<=c['verified_max_output_tokens']:raise RuntimeError('Claude request output cap differs')
        tools=params.get('tools',[])
        if len(tools)!=1 or tools[0].get('type')!=c.get('verified_search_tool_type') or tools[0].get('name')!='web_search' or type(tools[0].get('max_uses'))!=int or not 0<tools[0]['max_uses']<=c['verified_max_search_calls']:raise RuntimeError('Claude search bounds differ')
        body={**params,'model':c['model'],'system':SYSTEM,'messages':[{'role':'user','content':prompt}],'stream':False}
    else:raise RuntimeError('Unknown endpoint')
    if len(prompt.encode())>c.get('max_prompt_bytes',0):raise RuntimeError('Prompt exceeds reviewed request bound')
    return transport(ep,body,key,c['timeout_seconds'])

def parse(ep,r,c):
    if r.get('model') not in c['allowed_models']:raise RuntimeError('Returned model differs')
    if ep=='kimi_api' and str(r.get('provider','')).casefold() not in {v.casefold() for v in c['allowed_providers']}:raise RuntimeError('Returned provider differs')
    citations=[];texts=[];search=[];grounding='unknown';refusal=False
    if ep=='openai_api':
        outputs=r.get('output',[])
        if not isinstance(outputs,list):raise ValueError('Malformed output')
        for o in outputs:
            if o.get('type')=='web_search_call':search.append(o)
            if o.get('type')=='message':
                for b in o.get('content',[]):
                    if b.get('type')=='refusal':refusal=True
                    texts.append(b.get('text',b.get('refusal','')))
                    citations.extend(a['url'] for a in b.get('annotations',[]) if a.get('type')=='url_citation' and isinstance(a.get('url'),str))
        complete=r.get('status')=='completed' and not r.get('incomplete_details') and not r.get('error') and all(o.get('status') in (None,'completed') for o in outputs if o.get('type') in ('message','web_search_call'))
        if any(x.get('status')=='completed' for x in search):grounding='observed_search_completion'
    elif ep=='kimi_api':
        choices=r.get('choices',[])
        if len(choices)!=1:raise ValueError('Expected exactly one choice')
        msg=choices[0].get('message',{});content=msg.get('content')
        if isinstance(content,str):texts=[content]
        elif isinstance(content,list):texts=[x.get('text','') for x in content if isinstance(x,dict)]
        refusal=bool(msg.get('refusal'))
        if refusal:texts.append(str(msg['refusal']))
        citations.extend(a.get('url_citation',{}).get('url') for a in msg.get('annotations',[]) if a.get('type')=='url_citation')
        complete=choices[0].get('finish_reason')=='stop' and not r.get('error') and not msg.get('tool_calls')
        # Citations are not proof that search ran. Preserve raw telemetry for qualification.
    else:
        blocks=r.get('content',[])
        if not isinstance(blocks,list):raise ValueError('Malformed Claude content')
        for b in blocks:
            if b.get('type')=='text':
                texts.append(b.get('text',''))
                citations.extend(a.get('url') for a in b.get('citations',[]) if a.get('type')=='web_search_result_location')
            if b.get('type')=='web_search_tool_result':search.append(b)
        errors=[s for s in search if isinstance(s.get('content'),dict) and s['content'].get('type')=='web_search_tool_result_error']
        refusal=r.get('stop_reason')=='refusal'
        complete=r.get('stop_reason') in ('end_turn','refusal') and not r.get('error') and not errors
        if search and not errors:grounding='observed_search_result'
    effective=[x.get('user_location') for x in r.get('tools',[]) if isinstance(x,dict) and x.get('type') in ('web_search','web_search_20250305','web_search_20260209') and isinstance(x.get('user_location'),dict)]
    expected=c.get('requested_location')
    if c.get('require_location_echo') is True:
        if not expected or not effective or any(any(loc.get(k)!=v for k,v in expected.items()) for loc in effective):raise RuntimeError('Requested location not verified by response echo')
    answer='\n'.join(t for t in texts if isinstance(t,str))
    # An empty provider response is incomplete; a genuine textual refusal is a valid observation.
    complete=bool(complete and (answer.strip() or refusal))
    return {'answer':answer,'complete':complete,'refusal':refusal,'citations':sorted(set(x for x in citations if isinstance(x,str) and x.startswith(('http://','https://')))),'grounding':grounding,'returned_model':r.get('model'),'returned_provider':r.get('provider'),'usage':sanitize(r.get('usage')),'requested_location':expected,'effective_location_echo':effective or None,'location_status':'response_config_echo_not_browser_geolocation' if effective else 'not_returned','location_support':c.get('location_support','unverified')}

def micro(value):
    d=Decimal(str(value))
    if not d.is_finite() or d<0:raise ValueError('Invalid charge')
    return int((d*1000000).to_integral_value(rounding=ROUND_CEILING))
def tokens(u,k):
    v=u.get(k)
    if type(v)!=int or v<0:raise ValueError('Missing/invalid token usage')
    return v

def account(ep,r,c):
    """Return conservative charged-usage upper bound, never a made-up invoice figure."""
    u=r.get('usage')
    if not isinstance(u,dict):raise ValueError('Missing usage')
    if ep=='kimi_api':
        if c.get('usage_cost_verified_all_in') is not True or u.get('cost') is None:raise ValueError('No verified all-in charge')
        i,o=tokens(u,'prompt_tokens'),tokens(u,'completion_tokens')
        if i>c['verified_max_total_input_tokens'] or o>c['verified_max_total_output_tokens']:raise ValueError('Usage exceeds qualified bound')
        return micro(u['cost']),'provider_reported_charge'
    i,o=tokens(u,'input_tokens'),tokens(u,'output_tokens')
    operational=ep=='openai_api' and c.get('guard_mode')=='account_operational'
    if not operational and (i>c['verified_max_total_input_tokens'] or o>c['verified_max_total_output_tokens']):raise ValueError('Usage exceeds qualified bound')
    price=c['price'];cost=Decimal(i)*Decimal(str(price['input_per_million']))/1000000+Decimal(o)*Decimal(str(price['output_per_million']))/1000000
    if ep=='claude_api':
        total_input=i
        for field,rate in [('cache_creation_input_tokens','cache_write_per_million'),('cache_read_input_tokens','cache_read_per_million')]:
            n=u.get(field,0)
            if type(n)!=int or n<0:raise ValueError('Invalid cache usage')
            total_input+=n
            if n:
                if rate not in price:raise ValueError('Unpriced cache usage')
                cost+=Decimal(n)*Decimal(str(price[rate]))/1000000
        if total_input>c['verified_max_total_input_tokens']:raise ValueError('Total cache plus input exceeds bound')
        server=u.get('server_tool_use',{});calls=server.get('web_search_requests')
        if type(calls)!=int or calls<0 or calls>c['verified_max_search_calls']:raise ValueError('Missing/unbounded Claude search usage')
    elif operational:
        calls=u.get('tool_usage',{}).get('web_search',{}).get('num_requests')
        if type(calls)!=int or calls<0:raise ValueError('Operational search billing units missing; reconcile dashboard before resuming')
    else:
        # Charge maximum permitted searches conservatively; raw search telemetry may omit billing units.
        calls=c['verified_max_search_calls']
    cost+=Decimal(calls)*Decimal(str(price['search_per_call']))
    return micro(cost),('reported_token_and_search_units_at_reviewed_rates_not_invoice' if operational else 'conservative_usage_upper_bound')


def diagnostic_facts(r):
    """Allowlisted telemetry only; never response text, URL, error message, or request ID."""
    def label(v):return v if isinstance(v,str) and re.fullmatch(r'[A-Za-z0-9_./: -]{1,100}',v) else None
    u=r.get('usage') if isinstance(r.get('usage'),dict) else {}
    names=('input_tokens','output_tokens','prompt_tokens','completion_tokens','cache_creation_input_tokens','cache_read_input_tokens','cost','server_tool_use','tool_usage')
    facts={'returned_model':label(r.get('model')),'returned_provider':label(r.get('provider')),'provider_status':label(r.get('status')),'stop_reason':label(r.get('stop_reason')),'usage_fields_present':[k for k in names if k in u]}
    if isinstance(r.get('choices'),list) and r['choices']:facts['finish_reason']=label(r['choices'][0].get('finish_reason'))
    if isinstance(r.get('error'),dict):facts['provider_error_code']=label(r['error'].get('code'))
    facts['usage_numbers']={k:u[k] for k in names[:6] if type(u.get(k))==int and u[k]>=0}
    if type(u.get('cost')) in (int,float) and 0<=u['cost']<100000:facts['provider_reported_cost_usd']=u['cost']
    return facts
