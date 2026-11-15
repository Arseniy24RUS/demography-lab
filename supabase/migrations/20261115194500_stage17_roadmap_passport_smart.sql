-- Validate the optional SMART self-check in collaborative project passports.
create or replace function private.dw_s5_validate_data(k text,v jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare keys text[]; field text; x jsonb; p jsonb; n numeric; maxlen integer;
begin
  case k
    when 'passport' then keys:=array['title','targetGroup','partners','goal','objectives','startDate','endDate','expectedResult','defenseDate','humanResources','materialResources','informationResources'];
    when 'diagnosis' then keys:=array['problem','causeHypothesis','conclusion'];
    when 'monitoring' then keys:=array['frequency','method','responsible','interimReportDate','finalReportDate','qualitativeResults','sustainability'];
    when 'activity' then keys:=array['title','description','objectiveId','targetGroup','scale','startDate','endDate','responsible','partners','deliverable','completionCriterion','authorityLevel','legalBasis','approvalStatus','responsibleBody','necessaryDecision','indicatorIds','dependencies','stage','stageLabel','progressStatus'];
    when 'indicator' then keys:=array['title','definition','kind','unit','semanticType','valueDomain','numeratorDefinition','denominatorDefinition','baselineValue','baselineYear','annualTargets','sourceReference','frequency','responsible','limitations','scenarioId'];
    when 'scenario' then keys:=array['title','seriesId','seriesFingerprint','assumptions','parameters'];
    when 'cost' then keys:=array['activityId','year','title','unit','quantity','unitPriceKopecks','periods','cashKind','priceStatus','priceSource','priceDate'];
    when 'funding' then keys:=array['costLineId','sourceName','sourceKind','amountKopecks','status','sourceReference','sourceDate','originReference'];
    when 'risk' then keys:=array['title','mitigation','owner','trigger','contingency'];
    when 'fact' then keys:=array['sourceKind','title','interpretation','year','value','unit','sourceReference','sourceDate','seriesId','seriesFingerprint','metricId'];
    else return false;
  end case;
  -- Optional checklist: older passports keep their original payload.
  if k='passport' and v ? 'smartChecks' then
    if jsonb_typeof(v->'smartChecks') is distinct from 'array' then return false; end if;
    if jsonb_array_length(v->'smartChecks')>5 then return false; end if;
    for x in select value from jsonb_array_elements(v->'smartChecks') loop
      if jsonb_typeof(x) is distinct from 'string'
        or x#>>'{}' not in ('specific','measurable','achievable','relevant','timeBound') then return false; end if;
    end loop;
    if (select count(*)<>count(distinct value) from jsonb_array_elements(v->'smartChecks')) then return false; end if;
    keys:=array_append(keys,'smartChecks');
  end if;
  if not private.dw_s4_required(v,keys) or octet_length(v::text)>131072 then return false; end if;
  -- All human-readable fields have explicit limits; enum/ID/numeric fields follow below.
  foreach field in array keys loop
    if v->field='null'::jsonb and not (field=any(array['startDate','endDate','defenseDate','interimReportDate','finalReportDate','priceDate','sourceDate','objectiveId','baselineValue','baselineYear','scenarioId'])
      or (k='fact' and field=any(array['year','value','seriesId','seriesFingerprint','metricId']))) then return false; end if;
    if field=any(array['title','targetGroup','partners','goal','expectedResult','humanResources','materialResources','informationResources',
      'problem','causeHypothesis','conclusion','frequency','method','responsible','qualitativeResults','sustainability',
      'description','scale','deliverable','completionCriterion','legalBasis','responsibleBody','necessaryDecision','stageLabel',
      'definition','unit','numeratorDefinition','denominatorDefinition','sourceReference','limitations','assumptions',
      'priceSource','sourceName','originReference','mitigation','owner','trigger','contingency','interpretation']) then
      maxlen:=case when field=any(array['title','stageLabel','sourceName']) then 240 when field='unit' then 120
        when field=any(array['frequency','responsible','scale','responsibleBody','owner']) then 1000 else 4000 end;
      if not private.dw_text(v->field,0,maxlen) then return false; end if;
    end if;
    if field=any(array['startDate','endDate','defenseDate','interimReportDate','finalReportDate','priceDate','sourceDate'])
      and not private.dw_s5_date(v->field) then return false; end if;
  end loop;
  if k in ('passport','activity') and not private.dw_s5_dates(v) then return false; end if;
  if k='passport' then
    if jsonb_typeof(v->'objectives')<>'array' or jsonb_array_length(v->'objectives')>30 then return false; end if;
    for x in select value from jsonb_array_elements(v->'objectives') loop
      if not private.dw_s4_required(x,array['id','title']) or not private.dw_s4_uuid(x->'id') or not private.dw_text(x->'title',0,1000) then return false; end if;
    end loop;
    if (select count(*)<>count(distinct q->>'id') from jsonb_array_elements(v->'objectives') q) then return false; end if;
  elsif k='activity' then
    if not (v->'objectiveId'='null'::jsonb or private.dw_s4_uuid(v->'objectiveId'))
      or v->>'authorityLevel' not in ('municipal','regional','federal','organization','joint','unknown')
      or v->>'approvalStatus' not in ('unknown','requires_decision','verified_source','contradiction')
      or v->>'stage' not in ('preparation','implementation','evaluation','custom')
      or v->>'progressStatus' not in ('planned','in_progress','completed')
      or not private.dw_s5_ids(v->'indicatorIds',20)
      or jsonb_typeof(v->'dependencies')<>'array' or jsonb_array_length(v->'dependencies')>40 then return false; end if;
    for x in select value from jsonb_array_elements(v->'dependencies') loop
      if not private.dw_s4_required(x,array['predecessorId','lagDays']) or not private.dw_s4_uuid(x->'predecessorId')
        or not private.dw_s4_integer(x->'lagDays') or (x->>'lagDays')::numeric>3650 then return false; end if;
    end loop;
    if (select count(*)<>count(distinct q->>'predecessorId') from jsonb_array_elements(v->'dependencies') q) then return false; end if;
  elsif k='indicator' then
    if v->>'kind' not in ('resource','output','family_outcome','demographic_context')
      or v->>'semanticType' not in ('stock','flow','rate','share')
      or v->>'valueDomain' not in ('nonnegative','signed','percent','ratio')
      or not (v->'scenarioId'='null'::jsonb or private.dw_s4_uuid(v->'scenarioId'))
      or not (v->'baselineValue'='null'::jsonb or private.dw_s5_number(v->'baselineValue'))
      or not (v->'baselineYear'='null'::jsonb or private.dw_s5_year(v->'baselineYear'))
      or ((v->'baselineYear'='null'::jsonb)<>(v->'baselineValue'='null'::jsonb))
      or jsonb_typeof(v->'annualTargets')<>'array' or jsonb_array_length(v->'annualTargets')>31 then return false; end if;
    if v->>'baselineValue' is not null and not private.dw_s5_domain((v->>'baselineValue')::numeric,v->>'valueDomain') then return false; end if;
    for x in select value from jsonb_array_elements(v->'annualTargets') loop
      if not private.dw_s4_required(x,array['year','value']) or not private.dw_s5_year(x->'year')
        or not private.dw_s5_number(x->'value') or not private.dw_s5_domain((x->>'value')::numeric,v->>'valueDomain') then return false; end if;
    end loop;
    if (select count(*)<>count(distinct q->>'year') from jsonb_array_elements(v->'annualTargets') q) then return false; end if;
  elsif k='scenario' then
    if not private.dw_text(v->'seriesId',1,500) or v->>'seriesId'~'[[:space:]]' or not private.dw_text(v->'seriesFingerprint',64,64)
      or v->>'seriesFingerprint'!~'^[a-f0-9]{64}$' then return false; end if;
    p:=v->'parameters';
    if not private.dw_s4_required(p,array['metricId','historyStartYear','historyEndYear','endYear','baselineMethod','targetMode','targetValue'])
      or not private.dw_text(p->'metricId',1,500) or p->>'metricId'~'[[:space:]]'
      or not private.dw_s5_year(p->'historyStartYear') or not private.dw_s5_year(p->'historyEndYear') or not private.dw_s5_year(p->'endYear')
      or p->>'baselineMethod' not in ('last_value','linear')
      or p->>'targetMode' not in ('absolute_end','relative_end','annual_growth','absolute_delta_end','percentage_points')
      or not private.dw_s5_number(p->'targetValue') then return false; end if;
    if (p->>'historyStartYear')::int>(p->>'historyEndYear')::int or (p->>'endYear')::int<=(p->>'historyEndYear')::int
      or (p->>'historyEndYear')::int-(p->>'historyStartYear')::int>100
      or (p->>'targetMode'='annual_growth' and (p->>'targetValue')::numeric< -100) then return false; end if;
  elsif k='cost' then
    if not private.dw_s4_uuid(v->'activityId') or not private.dw_s5_year(v->'year')
      or not private.dw_text(v->'quantity',1,14) or v->>'quantity'!~'^(0|[1-9][0-9]{0,9})([.][0-9]{1,3})?$'
      or not private.dw_s4_integer(v->'unitPriceKopecks') or not private.dw_s4_integer(v->'periods',1)
      or (v->>'periods')::numeric>10000 or v->>'cashKind' not in ('cash','in_kind')
      or v->>'priceStatus' not in ('confirmed','estimated') then return false; end if;
    if private.dw_roadmap_cost(v)>9007199254740991 then return false; end if;
    if v->>'priceStatus'='confirmed' and (length(btrim(v->>'priceSource'))=0 or v->>'priceDate' is null) then return false; end if;
  elsif k='funding' then
    if not private.dw_s4_uuid(v->'costLineId') or not private.dw_s4_integer(v->'amountKopecks')
      or v->>'sourceKind' not in ('municipal_budget','regional_budget','federal_budget','employer','grant','other')
      or v->>'status' not in ('confirmed','budget_draft','application','assumption') then return false; end if;
    if v->>'status'='confirmed' and (length(btrim(v->>'sourceReference'))<3 or v->>'sourceDate' is null) then return false; end if;
  elsif k='fact' then
    if v->>'sourceKind' not in ('registry','team_statistics','external_unverified')
      or not (v->'year'='null'::jsonb or private.dw_s5_year(v->'year'))
      or not (v->'value'='null'::jsonb or private.dw_s5_number(v->'value')) then return false; end if;
    if v->>'sourceKind'='external_unverified' then
      if v->'seriesId'<>'null'::jsonb or v->'seriesFingerprint'<>'null'::jsonb or v->'metricId'<>'null'::jsonb then return false; end if;
    else
      if v->>'year' is null or v->>'value' is null or not private.dw_text(v->'seriesId',1,500)
        or not private.dw_text(v->'metricId',1,500) or not private.dw_text(v->'seriesFingerprint',64,64)
        or v->>'seriesFingerprint'!~'^[a-f0-9]{64}$' then return false; end if;
    end if;
  end if;
  return true;
exception when data_exception then return false;
end $$;
