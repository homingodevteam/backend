INSERT INTO cities (id, name, state, timezone, "isActive", "updatedAt") VALUES
  ('00000000-0000-4000-9000-000000000001', 'Indore', 'Madhya Pradesh', 'Asia/Kolkata', true, now()),
  ('00000000-0000-4000-9000-000000000002', 'Indore Centre Grid Fixture', 'Madhya Pradesh', 'Asia/Kolkata', true, now()),
  ('00000000-0000-4000-9000-000000000003', 'Indore Manual Grid Fixture', 'Madhya Pradesh', 'Asia/Kolkata', true, now()),
  ('00000000-0000-4000-9000-000000000004', 'Bhopal', 'Madhya Pradesh', 'Asia/Kolkata', true, now());

INSERT INTO roles (id, name, description, "permissionCodes", "isSystemRole", "updatedAt") VALUES
  ('00000000-0000-4000-8000-000000000001', 'geo_postman_admin', 'Isolated Geo Postman runner role', '["catalog.city.manage","pro.availability.set"]'::jsonb, false, now());

INSERT INTO admin_users (id, phone, "fullName", email, "firebaseUid", "roleId", "cityScopeJson", "isActive", "updatedAt") VALUES
  ('00000000-0000-4000-8000-000000000002', '+919900000001', 'Geo Postman Admin', 'geo-postman-admin@example.test', 'geo-postman-admin', '00000000-0000-4000-8000-000000000001', '[]'::jsonb, true, now()),
  ('00000000-0000-4000-8000-000000000003', '+919900000003', 'Bhopal Scoped Admin', 'geo-bhopal-admin@example.test', 'geo-bhopal-admin', '00000000-0000-4000-8000-000000000001', '["00000000-0000-4000-9000-000000000004"]'::jsonb, true, now());

INSERT INTO service_categories (id, name, slug, "sortOrder", "isActive", "updatedAt") VALUES
  ('00000000-0000-4000-a000-000000000001', 'Geo Test Services', 'geo-test-services', 1, true, now());

INSERT INTO services (id, "categoryId", name, description, "durationMinutes", "flatPrice", "commissionType", "commissionValue", "supportsInstant", "supportsScheduled", "supportsRecurring", "isActive", "allowsCash", "updatedAt") VALUES
  ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-a000-000000000001', 'Indore AC Service', 'Geo Postman primary service', 60, 599.00, 'percent', 25.00, true, true, false, true, true, now()),
  ('00000000-0000-4000-b000-000000000002', '00000000-0000-4000-a000-000000000001', 'Indore Deep Cleaning', 'Geo Postman secondary service', 120, 1499.00, 'percent', 30.00, true, true, false, true, true, now());

INSERT INTO customers (id, "deviceId", phone, "fullName", status, "verifiedAt", "isBlocked", "updatedAt") VALUES
  ('00000000-0000-4000-8000-000000000100', 'geo-postman-device', '+919900000100', 'Geo Postman Customer', 'active', now(), false, now());

INSERT INTO pros (id, phone, "fullName", "employeeCode", status, "isAvailable", "availabilityUpdatedAt", "cityId", "approvedAt", "updatedAt") VALUES
  ('00000000-0000-4000-8000-000000000101', '+919900000101', 'Geo Postman Professional', 'GEO-PM-001', 'approved', true, now(), '00000000-0000-4000-9000-000000000001', now(), now()),
  ('00000000-0000-4000-8000-000000000102', '+919900000102', 'Bhopal Professional', 'GEO-PM-002', 'approved', true, now(), '00000000-0000-4000-9000-000000000004', now(), now());

INSERT INTO pro_services (id, "proId", "serviceId", proficiency, "certifiedAt", "isActive", "updatedAt") VALUES
  ('00000000-0000-4000-8000-000000000110', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-b000-000000000001', 'expert', now(), true, now()),
  ('00000000-0000-4000-8000-000000000111', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-b000-000000000002', 'expert', now(), true, now());
