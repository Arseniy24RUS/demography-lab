-- Accept the expanded passport resource fields without changing stored passports.
alter function private.dw_s5_validate_data(text,jsonb) rename to dw_s19_validate_previous_data;

create function private.dw_s5_validate_data(k text,v jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare
  resource_keys constant text[]:=array['normativeResources','managementResources','researchResources',
    'economicResources','demographicResources','institutionalResources','technologyResources'];
  resource_key text;
begin
  if k='passport' then
    if octet_length(v::text)>131072 then return false; end if;
    foreach resource_key in array resource_keys loop
      if v ? resource_key and private.dw_text(v->resource_key,0,4000) is not true then return false; end if;
    end loop;
    v:=v-resource_keys;
  end if;
  return private.dw_s19_validate_previous_data(k,v);
end $$;
revoke all on function private.dw_s19_validate_previous_data(text,jsonb),
  private.dw_s5_validate_data(text,jsonb) from public,anon,authenticated,service_role;
