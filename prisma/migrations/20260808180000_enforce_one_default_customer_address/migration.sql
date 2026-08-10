-- Repair any pre-existing drift first. Prefer the address already referenced
-- by Customer.defaultAddressId; otherwise promote the newest saved address.
WITH ranked AS (
  SELECT
    address."id",
    address."customerId",
    ROW_NUMBER() OVER (
      PARTITION BY address."customerId"
      ORDER BY
        (address."id" = customer."defaultAddressId") DESC,
        address."createdAt" DESC,
        address."id" DESC
    ) AS position
  FROM "customer_addresses" address
  JOIN "customers" customer ON customer."id" = address."customerId"
)
UPDATE "customer_addresses" address
SET "isDefault" = (ranked.position = 1)
FROM ranked
WHERE address."id" = ranked."id";

UPDATE "customers" customer
SET "defaultAddressId" = address."id"
FROM "customer_addresses" address
WHERE address."customerId" = customer."id"
  AND address."isDefault" = true;

UPDATE "customers" customer
SET "defaultAddressId" = NULL
WHERE NOT EXISTS (
  SELECT 1
  FROM "customer_addresses" address
  WHERE address."customerId" = customer."id"
);

CREATE UNIQUE INDEX "customer_addresses_one_default_idx"
ON "customer_addresses" ("customerId")
WHERE "isDefault" = true;
