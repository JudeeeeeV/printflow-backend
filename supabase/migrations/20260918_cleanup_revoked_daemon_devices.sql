begin;

-- Revoked printer agents cannot authenticate again. Remove historical
-- soft-revoked rows now that revocation permanently deletes registrations.
delete from public.daemon_devices
where revoked_at is not null;

commit;
