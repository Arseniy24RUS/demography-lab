-- Permit the existing author-withdrawal handler through declared-identity entry.
-- This is not a moderator grant: all other operator-only methods stay unchanged.
do $migration$
declare definition text:=pg_get_functiondef('private.dw_entry_rpc(text,text,jsonb)'::regprocedure);
  anchor constant text:=$guard$and not (p_method=any(array['dw_save_family','dw_delete_family','dw_projector_snapshot','dw_workshop_projector_snapshot','dw_workshop_projector_updates','dw_barriers_projector_snapshot','dw_roadmaps_projector_snapshot']::text[]) and exists(select 1 from private.dw_current_workspace where session_id::text=p_args->>'p_session_id')) then perform private.dw_fail('FORBIDDEN'); end if;$guard$;
  replacement constant text:=$guard$and not ((p_method=any(array['dw_save_family','dw_delete_family','dw_projector_snapshot','dw_workshop_projector_snapshot','dw_workshop_projector_updates','dw_barriers_projector_snapshot','dw_roadmaps_projector_snapshot']::text[]) and exists(select 1 from private.dw_current_workspace where session_id::text=p_args->>'p_session_id'))
   or (p_method='dw_moderate_submission' and p_args->>'p_status'='withdrawn'
     and exists(select 1 from public.dw_submissions source
       join private.dw_current_workspace current_workspace on current_workspace.session_id=source.session_id
       where source.session_id::text=p_args->>'p_session_id' and source.id::text=p_args->>'p_submission_id'
         and source.author_id=v_session.actor_id and not(source.bundle ? 'catalogSource')
         and (source.status='shared' or exists(select 1 from private.command_receipts receipt
           where receipt.actor_id=v_session.actor_id and receipt.operation_id::text=p_args->>'p_operation_id'
             and receipt.operation_type='moderate_submission'
             and receipt.result->>'sessionId'=source.session_id::text and receipt.result->>'entityId'=source.id::text)))))
   then perform private.dw_fail('FORBIDDEN'); end if;$guard$;
begin
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
    raise exception 'Expected exactly one operator gateway guard';
  end if;
  -- An already withdrawn source may only reach the existing receipt verifier for
  -- this actor's completed operation on this exact source. That verifier enforces
  -- operation kind and payload hash before replay; altered payloads still conflict.
  -- The handler retains membership, role, session, frozen-material and CAS guards.
  execute replace(definition,anchor,replacement);
end
$migration$;
