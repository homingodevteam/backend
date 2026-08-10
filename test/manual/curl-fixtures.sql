INSERT INTO cities (id, "createdAt", "updatedAt", name, state, timezone, "isActive")
VALUES
  ('10000000-0000-0000-0000-000000000001', now(), now(), 'Indore', 'MP', 'Asia/Kolkata', true),
  ('10000000-0000-0000-0000-000000000002', now(), now(), 'Mumbai', 'MH', 'Asia/Kolkata', true);

INSERT INTO admin_users
  (id, "createdAt", "updatedAt", phone, "fullName", "roleId", "cityScopeJson", "isActive")
SELECT
  '20000000-0000-0000-0000-000000000001', now(), now(), '+919000000010',
  'Indore Ops', id, '["10000000-0000-0000-0000-000000000001"]', true
FROM roles WHERE name = 'ops';

INSERT INTO pros (id, "createdAt", "updatedAt", phone, "fullName", status, "cityId")
VALUES
  ('30000000-0000-0000-0000-000000000001', now(), now(), '+919000000011', 'Indore Pro', 'approved', '10000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000002', now(), now(), '+919000000012', 'Mumbai Pro', 'approved', '10000000-0000-0000-0000-000000000002');
