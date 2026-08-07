-- Backs ProsService.generateEmployeeCode() — atomic under concurrent
-- approvals. Not expressible in schema.prisma since it's not tied to a
-- column default; the app calls nextval() on it directly via $queryRaw.
CREATE SEQUENCE "pro_employee_code_seq";
