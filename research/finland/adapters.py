"""Explicit, injectable HTTP transport; no imports read credentials or make requests.
Live use requires separately verified configuration and release gates.
"""
import json
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
from runner import SYSTEM

class ProviderError(Exception):
    def __init__(self,category,retry_after=60):
        self.category=category;self.retry_after=retry_after
        super().__init__(category)  # Never include response body, header, or credential.

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise ProviderError('fatal_redirect')

def http_json(url,body,key,timeout=90):
    req=Request(url,json.dumps(body).encode(),{'Authorization':'Bearer '+key,'Content-Type':'application/json'},method='POST')
    try:
        with build_opener(NoRedirect).open(req,timeout=timeout) as response:
            return json.load(response)
    except HTTPError as e:
        try: retry_after=max(60,float(e.headers.get('Retry-After','60')))
        except (ValueError,TypeError):retry_after=60
        if e.code==429:raise ProviderError('429',retry_after) from None
        if e.code>=500:raise ProviderError('5xx',retry_after) from None
        raise ProviderError('fatal_http_'+str(e.code)) from None
    except (URLError,TimeoutError):raise ProviderError('timeout') from None
    except (json.JSONDecodeError,UnicodeDecodeError):raise ProviderError('unknown_response') from None

def request_openai(prompt,config,key,transport=http_json):
    if not config.get('qualified'):raise RuntimeError('OpenAI qualification gate closed')
    if not config.get('all_billable_bound_verified'):raise RuntimeError('OpenAI billing bound unverified')
    if not config.get('model') or not key:raise RuntimeError('Explicit model and injected credential required')
    body={'model':config['model'],'instructions':SYSTEM,'input':prompt,'tools':[{'type':'web_search',**config.get('search_parameters',{})}], 'max_tool_calls':config['max_tool_calls'],'max_output_tokens':config['max_output_tokens'],'tool_choice':config['tool_choice'],'store':False}
    if 'temperature' in config:body['temperature']=config['temperature']
    # No previous_response_id, history, SDK retry, implicit fallback or customer context.
    return transport('https://api.openai.com/v1/responses',body,key)

def request_kimi(prompt,config,key,transport=http_json):
    # Exact provider-specific body is intentionally required from reviewed qualification.
    # Do not silently translate OpenAI tool parameters into Kimi or invent loop caps.
    if not config.get('qualified') or not config.get('all_billable_bound_verified'):
        raise RuntimeError('Kimi route/search/billing qualification gate closed')
    if config.get('route')!='openrouter':raise RuntimeError('Only explicitly reviewed OpenRouter route supported')
    if not config.get('model') or not config.get('provider') or not key:raise RuntimeError('Pinned model/provider and injected credential required')
    if config.get('native_tool_loop_required'):raise RuntimeError('Native tool loop needs separately reviewed bounded implementation')
    if not config.get('reviewed_request_parameters'):raise RuntimeError('Reviewed Kimi request parameters absent')
    body={**config['reviewed_request_parameters'],'model':config['model'],'messages':[{'role':'system','content':SYSTEM},{'role':'user','content':prompt}],'provider':{'only':[config['provider']],'order':[config['provider']],'allow_fallbacks':False,'require_parameters':True,'max_price':{'prompt':2,'completion':10}}}
    return transport('https://openrouter.ai/api/v1/chat/completions',body,key)
