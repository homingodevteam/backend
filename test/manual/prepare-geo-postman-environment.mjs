import { readFile, writeFile } from 'node:fs/promises';
import jwt from 'jsonwebtoken';

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  throw new Error(
    'Usage: node prepare-geo-postman-environment.mjs <source> <target>',
  );
}

const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('JWT_SECRET is required');

const environment = JSON.parse(await readFile(source, 'utf8'));
const tokens = {
  adminToken: jwt.sign(
    {
      sub: '00000000-0000-4000-8000-000000000002',
      actorType: 'admin',
      roleId: '00000000-0000-4000-8000-000000000001',
      accessMode: 'full',
      type: 'access',
    },
    secret,
    { expiresIn: '1h' },
  ),
  scopedAdminToken: jwt.sign(
    {
      sub: '00000000-0000-4000-8000-000000000003',
      actorType: 'admin',
      roleId: '00000000-0000-4000-8000-000000000001',
      accessMode: 'full',
      type: 'access',
    },
    secret,
    { expiresIn: '1h' },
  ),
  customerToken: jwt.sign(
    {
      sub: '00000000-0000-4000-8000-000000000100',
      actorType: 'customer',
      accessMode: 'full',
      type: 'access',
    },
    secret,
    { expiresIn: '1h' },
  ),
  proToken: jwt.sign(
    {
      sub: '00000000-0000-4000-8000-000000000101',
      actorType: 'pro',
      accessMode: 'full',
      type: 'access',
    },
    secret,
    { expiresIn: '1h' },
  ),
};

for (const entry of environment.values) {
  if (tokens[entry.key]) entry.value = tokens[entry.key];
}
await writeFile(target, `${JSON.stringify(environment, null, 2)}\n`);
