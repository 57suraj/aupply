-- ============================================================================
-- Fix: deleting a user failed with "permission denied for table applications".
--
-- GoTrue deletes users as supabase_auth_admin. The cascade into
-- application_events fires application_events_sync_stage, which ran as the
-- invoker and so could not update public.applications.
--
-- The trigger now runs as its owner. That is safe: an event can only point at
-- an application of the same user (composite FK), so the trigger can only
-- recompute that user's own application. The helper it calls is no longer
-- executable by API roles, since nothing but the trigger needs it.
-- ============================================================================

alter function public.application_events_sync_stage() security definer;

revoke execute on function public.recompute_application_stage(uuid) from public, anon, authenticated;
revoke execute on function public.application_events_sync_stage() from public, anon, authenticated;
