-- Allow the history-anchored baseline alongside the existing saved methods.
alter function private.dw_s5_validate_data(text,jsonb) rename to dw_s17_validate_previous_data;

create function private.dw_s5_validate_data(k text,v jsonb) returns boolean
language sql immutable set search_path='' as $$
  select private.dw_s17_validate_previous_data(k,
    case when k='scenario' and v#>>'{parameters,baselineMethod}'='historical_continuation'
      then jsonb_set(v,'{parameters,baselineMethod}','"last_value"'::jsonb,false) else v end)
$$;
revoke all on function private.dw_s17_validate_previous_data(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function private.dw_s5_validate_data(text,jsonb) from public,anon,authenticated,service_role;

create or replace function private.dw_roadmap_validate_room(p_room uuid) returns void language plpgsql set search_path='' as $$
declare x record; s jsonb; p jsonb; point jsonb; base numeric; cnt integer; start_year integer; end_year integer; first_year integer; horizon integer; result_value numeric; mean_x numeric; mean_y numeric; slope numeric; intercept numeric; base_end numeric; base_first numeric;
begin
  -- References are always local and point to active records. An archive is a
  -- deliberate operation; dependencies cannot silently disappear.
  if exists(select 1 from private.dw_roadmap_items i where i.roadmap_id=p_room and i.status='active' and (
    (i.kind='activity' and (
      (i.data->>'objectiveId' is not null and not exists(select 1 from private.dw_roadmap_items pass,jsonb_array_elements(pass.data->'objectives') o
        where pass.roadmap_id=p_room and pass.kind='passport' and o->>'id'=i.data->>'objectiveId'))
      or exists(select 1 from jsonb_array_elements_text(i.data->'indicatorIds') j where not exists(
        select 1 from private.dw_roadmap_items t where t.roadmap_id=p_room and t.id::text=j and t.kind='indicator' and t.status='active'))
      or exists(select 1 from jsonb_array_elements(i.data->'dependencies') j where j->>'predecessorId'=i.id::text or not exists(
        select 1 from private.dw_roadmap_items t where t.roadmap_id=p_room and t.id::text=j->>'predecessorId' and t.kind='activity' and t.status='active'))))
    or (i.kind='indicator' and i.data->>'scenarioId' is not null and not exists(select 1 from private.dw_roadmap_items t
      where t.roadmap_id=p_room and t.id::text=i.data->>'scenarioId' and t.kind='scenario' and t.status='active'))
    or (i.kind='cost' and not exists(select 1 from private.dw_roadmap_items t where t.roadmap_id=p_room and t.id::text=i.data->>'activityId' and t.kind='activity' and t.status='active'))
    or (i.kind='funding' and not exists(select 1 from private.dw_roadmap_items t where t.roadmap_id=p_room and t.id::text=i.data->>'costLineId'
      and t.kind='cost' and t.status='active' and t.data->>'cashKind'='cash'))
  )) then perform private.dw_fail('ROADMAP_REFERENCE'); end if;
  if exists(
    with recursive edges as (
      select i.id a,(j->>'predecessorId')::uuid b from private.dw_roadmap_items i,jsonb_array_elements(i.data->'dependencies') j
        where i.roadmap_id=p_room and i.kind='activity' and i.status='active'
    ), reach(a,b) as (
      select a,b from edges union
      select r.a,e.b from reach r join edges e on e.a=r.b
    ) select 1 from reach where a=b
  ) then perform private.dw_fail('ROADMAP_CYCLE'); end if;
  if exists(select 1 from private.dw_roadmap_items c where c.roadmap_id=p_room and c.kind='cost' and c.status='active'
    and (select coalesce(sum((f.data->>'amountKopecks')::numeric),0) from private.dw_roadmap_items f
      where f.roadmap_id=p_room and f.kind='funding' and f.status='active' and f.data->>'costLineId'=c.id::text)>private.dw_roadmap_cost(c.data))
    then perform private.dw_fail('BUDGET_OVERALLOCATED'); end if;
  perform private.dw_roadmap_budget(p_room);
  if exists(select 1 from private.dw_roadmap_items i join private.dw_roadmap_items sc on sc.roadmap_id=i.roadmap_id and sc.id::text=i.data->>'scenarioId'
    cross join lateral (select private.dw_s6_resolve_series(p_room,sc.data->>'seriesId',sc.data->>'seriesFingerprint') material) ser
    where i.roadmap_id=p_room and i.kind='indicator' and i.status='active' and (
      i.data->>'semanticType'<>ser.material->>'semanticType' or i.data->>'valueDomain'<>ser.material->>'valueDomain'
      or (ser.material->>'unit'='persons' and lower(btrim(i.data->>'unit')) not in ('persons','человек','чел.'))))
    then perform private.dw_fail('SCENARIO_INDICATOR_MISMATCH'); end if;
  for x in select i.data from private.dw_roadmap_items i where i.roadmap_id=p_room and i.kind='scenario' and i.status='active' loop
    p:=x.data->'parameters';
    s:=private.dw_s6_resolve_series(p_room,x.data->>'seriesId',x.data->>'seriesFingerprint');
    if s is null or s->>'metricId'<>p->>'metricId' then perform private.dw_fail('SOURCE_MISMATCH'); end if;
    start_year:=(p->>'historyStartYear')::int; end_year:=(p->>'historyEndYear')::int;
    select pt into point from jsonb_array_elements(s->'points') pt
      where (pt->>'year')::int between start_year and end_year and pt->>'value' is not null order by (pt->>'year')::int desc limit 1;
    if point is null then perform private.dw_fail('SCENARIO_HISTORY'); end if;
    base:=(point->>'value')::numeric;
    select count(*),min((pt->>'year')::int) into cnt,first_year from jsonb_array_elements(s->'points') pt
      where (pt->>'year')::int between start_year and end_year and pt->>'value' is not null;
    end_year:=(point->>'year')::int; horizon:=(p->>'endYear')::int-end_year;
    if horizon<1 or horizon>30 then perform private.dw_fail('SCENARIO_HISTORY'); end if;
    if p->>'baselineMethod'='linear' and (cnt<5 or cnt<>end_year-first_year+1) then perform private.dw_fail('SCENARIO_HISTORY'); end if;
    base_end:=base; base_first:=base;
    if p->>'baselineMethod'='linear' then
      select avg((pt->>'year')::numeric-first_year),avg((pt->>'value')::numeric) into mean_x,mean_y
        from jsonb_array_elements(s->'points') pt where (pt->>'year')::int between first_year and end_year and pt->>'value' is not null;
      select sum(((pt->>'year')::numeric-first_year-mean_x)*((pt->>'value')::numeric-mean_y)) /
        sum(power((pt->>'year')::numeric-first_year-mean_x,2)) into slope
        from jsonb_array_elements(s->'points') pt where (pt->>'year')::int between first_year and end_year and pt->>'value' is not null;
      intercept:=mean_y-slope*mean_x;
      base_end:=intercept+slope*((p->>'endYear')::int-first_year); base_first:=intercept+slope*(end_year+1-first_year);
      if s->>'valueDomain'<>'signed' then base_end:=greatest(0,base_end); base_first:=greatest(0,base_first); end if;
    elsif p->>'baselineMethod'='historical_continuation' and cnt>=5 then
      -- Same recent observations, median pairwise slope and damping as historical-trend.ts.
      with recent as (
        select (pt->>'year')::int as observation_year,(pt->>'value')::numeric as val
          from jsonb_array_elements(s->'points') pt
          where (pt->>'year')::int between start_year and end_year and pt->>'value' is not null
          order by (pt->>'year')::int desc limit 10
      ), ordered as (
        select array_agg(pair_slope order by pair_slope) slopes
          from (
            select (r.val-l.val)/(r.observation_year-l.observation_year) as pair_slope
              from recent l join recent r on r.observation_year>l.observation_year
          ) pairs
      )
      select (slopes[(cardinality(slopes)+1)/2]+slopes[(cardinality(slopes)+2)/2])/2 into slope from ordered;
      base_first:=base+slope;
      base_end:=base+slope*(1-power(0.9::numeric,horizon))/0.1;
      if s->>'valueDomain'<>'signed' then base_end:=greatest(0,base_end); base_first:=greatest(0,base_first); end if;
    end if;
    if p->>'targetMode' in ('relative_end','annual_growth') and (s->>'valueDomain'='signed' or base<=0 or (p->>'targetMode'='relative_end' and least(base_first,base_end)<=0))
      then perform private.dw_fail('SCENARIO_DOMAIN'); end if;
    if p->>'targetMode'='percentage_points' and s->>'valueDomain'<>'percent' then perform private.dw_fail('SCENARIO_DOMAIN'); end if;
    if p->>'targetMode'='absolute_end' then result_value:=(p->>'targetValue')::numeric;
    elsif p->>'targetMode'='absolute_delta_end' then result_value:=base_end+(p->>'targetValue')::numeric;
    elsif p->>'targetMode'='relative_end' then result_value:=base_end*(1+(p->>'targetValue')::numeric/100);
    elsif p->>'targetMode'='annual_growth' then result_value:=base*power(1+(p->>'targetValue')::numeric/100,horizon);
    else result_value:=base_end+(p->>'targetValue')::numeric; end if;
    if abs(result_value)>1e15 or not private.dw_s5_domain(result_value,s->>'valueDomain') then perform private.dw_fail('SCENARIO_DOMAIN'); end if;
  end loop;
end $$;
