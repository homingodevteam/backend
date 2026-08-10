-- Admin mutation auditing is intentionally deferred until its product and
-- retention requirements are decided. No development flow should depend on
-- this table in the meantime.
DROP TABLE IF EXISTS "admin_audit_logs";
