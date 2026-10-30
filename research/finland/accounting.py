"""Recognized spend: exact OpenRouter charge or conservative OpenAI upper bound."""
from decimal import Decimal,ROUND_CEILING,InvalidOperation

def cost(response,endpoint,config):
    usage=response.get('usage')
    if not isinstance(usage,dict):return {'actual':None,'accounted':None,'basis':'unknown'}
    if endpoint=='kimi_candidate' and config.get('usage_cost_verified_all_in') is True:
        raw=usage.get('cost')
        if isinstance(raw,bool) or not isinstance(raw,(int,float,str)):return {'actual':None,'accounted':None,'basis':'unknown'}
        try:value=Decimal(str(raw))
        except InvalidOperation:return {'actual':None,'accounted':None,'basis':'unknown'}
        if not value.is_finite() or value<0:return {'actual':None,'accounted':None,'basis':'unknown'}
        return {'actual':int((value*1000000).to_integral_value(rounding=ROUND_CEILING)),'accounted':None,'basis':'provider_usage_cost'}
    if endpoint=='openai_responses' and config.get('usage_upper_bound_accounting_verified') is True:
        inp,out=usage.get('input_tokens'),usage.get('output_tokens')
        if any(type(x)!=int or x<0 for x in (inp,out)):return {'actual':None,'accounted':None,'basis':'unknown'}
        if config.get('model')!='gpt-4.1-mini-2025-04-14' or config.get('max_tool_calls')!=2 or config.get('max_output_tokens')!=1500:return {'actual':None,'accounted':None,'basis':'unknown'}
        if out>1500 or sum(x.get('type')=='web_search_call' for x in response.get('output',[]) if isinstance(x,dict))>2:return {'actual':None,'accounted':None,'basis':'usage_cap_deviation'}
        # No cache discount. Charge FULL configured2 searches even if telemetry is absent.
        # Fixed8K/search may already be in usage.input_tokens; never refund this ambiguity.
        micro=Decimal(inp)*Decimal('.4')+Decimal(out)*Decimal('1.6')+Decimal(26400)
        return {'actual':None,'accounted':int(micro.to_integral_value(rounding=ROUND_CEILING)),'basis':'conservative_usage_upper_bound'}
    return {'actual':None,'accounted':None,'basis':'unknown'}
