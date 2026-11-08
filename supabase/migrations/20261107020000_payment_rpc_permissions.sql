begin;

-- Repair installations where the payment transaction exists but the backend
-- service role is missing its EXECUTE grant. Keep browser roles excluded.
revoke all on function public.apply_order_decision(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_order_decision(uuid, uuid, text, text, jsonb)
  to service_role;

notify pgrst, 'reload schema';
commit;
