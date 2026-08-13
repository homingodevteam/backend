import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'postman');

const ids = {
  city: '00000000-0000-4000-9000-000000000001',
  centerGridCity: '00000000-0000-4000-9000-000000000002',
  manualCity: '00000000-0000-4000-9000-000000000003',
  service: '00000000-0000-4000-b000-000000000001',
  secondService: '00000000-0000-4000-b000-000000000002',
  pro: '00000000-0000-4000-8000-000000000101',
  bhopalPro: '00000000-0000-4000-8000-000000000102',
};

const pilotBox = {
  minLat: 22.68,
  maxLat: 22.7518,
  minLng: 75.82,
  maxLng: 75.8978,
  cellSizeKm: 2,
};
const keepBox = {
  minLat: 22.697,
  maxLat: 22.7355,
  minLng: 75.838,
  maxLng: 75.8795,
};
const suppliedPin = { lat: 22.724158, lng: 75.905052 };

const expectedNames = {
  A1: 'Rau',
  A2: 'CAT Road',
  A3: 'Chandan Nagar',
  A4: 'Airport Road',
  B1: 'Silicon City',
  B2: 'Rajendra Nagar',
  B3: 'Annapurna Road',
  B4: 'Rajwada',
  C1: 'Bhawarkuan',
  C2: 'Sapna Sangeeta',
  C3: 'Palasia',
  C4: 'Bengali Square',
  D1: 'Super Corridor',
  D2: 'Mahalaxmi Nagar',
  D3: 'Vijay Nagar',
  D4: 'Scheme No 140',
};

const json = (value) => JSON.stringify(value, null, 2);
const rawBody = (value) => ({
  mode: 'raw',
  raw: json(value),
  options: { raw: { language: 'json' } },
});
const bearer = (variable) => ({
  type: 'bearer',
  bearer: [{ key: 'token', value: `{{${variable}}}`, type: 'string' }],
});
const script = (type, lines) => ({
  listen: type,
  script: { type: 'text/javascript', exec: lines },
});
const ok = (status = 200, extra = []) => [
  `pm.test('HTTP ${status}', () => pm.response.to.have.status(${status}));`,
  'var responseBody = pm.response.json();',
  "pm.test('standard success envelope', () => { pm.expect(responseBody.success).to.eql(true); pm.expect(responseBody.statusCode).to.eql(pm.response.code); });",
  ...extra,
];
const rejected = (status, code, extra = []) => [
  `pm.test('HTTP ${status}', () => pm.response.to.have.status(${status}));`,
  'var responseBody = pm.response.json();',
  "pm.test('standard failure envelope', () => { pm.expect(responseBody.success).to.eql(false); pm.expect(responseBody.statusCode).to.eql(pm.response.code); });",
  ...(code
    ? [
        `pm.test('domain error ${code}', () => pm.expect(JSON.stringify(responseBody.errors)).to.include('${code}'));`,
      ]
    : []),
  ...extra,
];

function request(
  name,
  method,
  path,
  { auth, body, tests = ok(), prerequest, description } = {},
) {
  const item = {
    name,
    request: {
      method,
      header: body ? [{ key: 'Content-Type', value: 'application/json' }] : [],
      url: {
        raw: `{{baseUrl}}${path}`,
        host: ['{{baseUrl}}'],
        path: path.split('/').filter(Boolean),
      },
      ...(auth ? { auth: bearer(auth) } : {}),
      ...(body ? { body: rawBody(body) } : {}),
      ...(description ? { description } : {}),
    },
    response: [],
  };
  const events = [];
  if (prerequest) events.push(script('prerequest', prerequest));
  if (tests) events.push(script('test', tests));
  if (events.length) item.event = events;
  return item;
}

const admin = 'adminToken';
const customer = 'customerToken';
const pro = 'proToken';

const collection = {
  info: {
    _postman_id: '5de92d09-9a4d-4dba-9fea-8a15f173ca13',
    name: 'Homingo Geo — Indore complete endpoint verification',
    description:
      'Executable documentation for customer OTP registration, every Geo/Area endpoint, and the city, customer-address and Pro-location endpoints that complete the operational workflow. The automated scenario registers the supplied test customer, creates and prunes a 4×4 Indore pilot grid, names every cell through the Google adapter, checks every cell address against its coordinates, configures services, posts a Pro, and verifies customer resolution.',
    schema:
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    {
      key: 'expectedNames',
      value: JSON.stringify(expectedNames),
      type: 'string',
    },
  ],
  item: [
    {
      name: '0 — Customer OTP registration',
      description:
        'Registers the requested Indian mobile number through the same OTP endpoints used by the customer app. Automated runs use OTP_PROVIDER=mock and a secret fixture code; production sends and verifies through the configured provider.',
      item: [
        request('Request registration OTP', 'POST', '/auth/otp/request', {
          body: {
            phone: '{{registrationPhone}}',
            actorType: 'customer',
          },
          tests: ok(201, [
            "pm.environment.set('registrationProviderRef', responseBody.data.providerRef);",
            "pm.test('opaque OTP reference returned', () => pm.expect(responseBody.data.providerRef).to.be.a('string').and.not.empty);",
          ]),
          description:
            'Accepts a 10-digit Indian number and normalizes it to E.164 (+91...). The provider reference is opaque and is captured for verification.',
        }),
        request('Verify registration OTP', 'POST', '/auth/otp/verify', {
          body: {
            phone: '{{registrationPhone}}',
            code: '{{registrationOtp}}',
            providerRef: '{{registrationProviderRef}}',
            actorType: 'customer',
          },
          tests: ok(201, [
            "pm.environment.set('registrationAccessToken', responseBody.data.accessToken);",
            "pm.environment.set('registrationRefreshToken', responseBody.data.refreshToken);",
            "pm.test('registration issues a token pair', () => { pm.expect(responseBody.data.accessToken).to.be.a('string').and.not.empty; pm.expect(responseBody.data.refreshToken).to.be.a('string').and.not.empty; });",
          ]),
          description:
            'Verifies the one-time code, creates or resolves the customer, and returns access and refresh tokens. OTP and tokens are redacted from retained evidence.',
        }),
      ],
    },
    {
      name: '1 — City administration',
      item: [
        request('List cities', 'GET', '/admin/catalog/cities', { auth: admin }),
        request('Add a city', 'POST', '/admin/catalog/cities', {
          auth: admin,
          body: {
            name: 'Postman Indore QA',
            state: 'Madhya Pradesh',
            timezone: 'Asia/Kolkata',
            isActive: false,
          },
          tests: ok(201, [
            "pm.environment.set('createdCityId', responseBody.data.id);",
            "pm.test('city starts inactive', () => pm.expect(responseBody.data.isActive).to.eql(false));",
          ]),
        }),
        request(
          'Update city metadata',
          'PATCH',
          '/admin/catalog/cities/{{createdCityId}}',
          {
            auth: admin,
            body: {
              name: 'Postman Indore Verification',
              timezone: 'Asia/Kolkata',
            },
            tests: ok(200, [
              "pm.test('city metadata updated', () => pm.expect(responseBody.data.name).to.eql('Postman Indore Verification')); ",
            ]),
          },
        ),
        request(
          'Activate city with explicit no-supply acknowledgement',
          'PATCH',
          '/admin/catalog/cities/{{createdCityId}}/activation',
          {
            auth: admin,
            body: { isActive: true, acknowledgeNoSupply: true },
            tests: ok(200, [
              "pm.test('city activated', () => pm.expect(responseBody.data.isActive).to.eql(true));",
            ]),
          },
        ),
      ],
    },
    {
      name: '2 — Grid planning, generation, pruning and naming',
      item: [
        request(
          'Fetch official Indore city bounds',
          'GET',
          '/admin/areas/city-bounds?name=Indore%2C%20Madhya%20Pradesh%2C%20India&cellSizeKm=2',
          {
            auth: admin,
            tests: ok(200, [
              "pm.test('correct city matched through Google adapter', () => { pm.expect(responseBody.data.matchedName).to.include('Indore'); pm.expect(responseBody.data.provider).to.eql('google'); pm.expect(responseBody.data.cellCount).to.be.above(0); });",
            ]),
          },
        ),
        request(
          'Preview pilot grid without writing',
          'POST',
          '/admin/areas/preview-grid',
          {
            auth: admin,
            body: { ...pilotBox, nameLimit: 0 },
            tests: ok(201, [
              "pm.test('preview is a 4x4 grid', () => { pm.expect(responseBody.data.cellCount).to.eql(16); pm.expect(responseBody.data.cells).to.have.length(16); });",
            ]),
          },
        ),
        request(
          'Generate grid from centre (legacy supported path)',
          'POST',
          '/admin/areas/generate-grid',
          {
            auth: admin,
            body: {
              cityId: ids.centerGridCity,
              centerLat: 22.7196,
              centerLng: 75.8577,
              extentKm: 1,
              cellSizeKm: 2,
            },
            tests: ok(201, [
              "pm.test('centre-based grid created', () => pm.expect(responseBody.data.length).to.be.above(0));",
            ]),
          },
        ),
        request(
          'Generate 4x4 Indore pilot grid for a box',
          'POST',
          '/admin/areas/generate-grid-for-box',
          {
            auth: admin,
            body: { cityId: ids.city, ...pilotBox },
            tests: ok(201, [
              "pm.test('16 gapless cells created', () => { pm.expect(responseBody.data).to.have.length(16); pm.expect(new Set(responseBody.data.map(a => a.gridRef)).size).to.eql(16); });",
            ]),
          },
        ),
        request(
          'List all active generated zones',
          'GET',
          '/admin/areas?cityId={{cityId}}',
          {
            auth: admin,
            tests: ok(200, [
              "pm.test('all 16 start active', () => pm.expect(responseBody.data).to.have.length(16));",
            ]),
          },
        ),
        request(
          'Dry-run removal of zones beyond operational boundary',
          'POST',
          '/admin/areas/deactivate-outside',
          {
            auth: admin,
            body: { cityId: ids.city, ...keepBox, dryRun: true },
            tests: ok(201, [
              "pm.test('dry run identifies 12 outside cells without changing them', () => { pm.expect(responseBody.data.considered).to.eql(16); pm.expect(responseBody.data.deactivated).to.eql(0); pm.expect(responseBody.data.kept).to.eql(4); pm.expect(responseBody.data.names).to.have.length(12); });",
            ]),
          },
        ),
        request(
          'Deactivate zones beyond operational boundary',
          'POST',
          '/admin/areas/deactivate-outside',
          {
            auth: admin,
            body: { cityId: ids.city, ...keepBox, dryRun: false },
            tests: ok(201, [
              "pm.test('12 outside cells deactivated and 4 retained', () => { pm.expect(responseBody.data.deactivated).to.eql(12); pm.expect(responseBody.data.kept).to.eql(4); });",
            ]),
          },
        ),
        request(
          'Start zone naming from reverse-geocoded centres',
          'POST',
          '/admin/areas/suggest-names?cityId={{cityId}}',
          {
            auth: admin,
            tests: ok(201, [
              "pm.test('all 16 cells queued', () => { pm.expect(responseBody.data.queued).to.eql(16); pm.expect(responseBody.data.running).to.eql(true); });",
            ]),
          },
        ),
        request(
          'Wait for and verify naming completion',
          'GET',
          '/admin/areas/naming-progress?cityId={{cityId}}',
          {
            auth: admin,
            prerequest: [
              '// Allow the asynchronous Google-compatible naming pass to settle.',
              'setTimeout(() => {}, 1000);',
            ],
            tests: ok(200, [
              "pm.test('naming pass completed', () => { pm.expect(responseBody.data.running).to.eql(false); pm.expect(responseBody.data.pending).to.eql(0); pm.expect(responseBody.data.suggested).to.eql(16); });",
            ]),
          },
        ),
        request(
          'Audit names, active boundary and grid geometry',
          'GET',
          '/admin/areas?cityId={{cityId}}&includeInactive=true',
          {
            auth: admin,
            tests: ok(200, [
              "const expected = JSON.parse(pm.collectionVariables.get('expectedNames'));",
              'const areas = responseBody.data;',
              "pm.test('all grid references have the expected Indore locality', () => areas.forEach(a => pm.expect(a.name, a.gridRef).to.eql(expected[a.gridRef])));",
              "pm.test('every zone persists its Google centre address and provider audit', () => areas.forEach(a => { pm.expect(a.addressLine, a.gridRef).to.include(a.name); pm.expect(a.addressProvider).to.eql('google'); pm.expect(a.addressAttribution).to.include('Google'); pm.expect(a.addressUpdatedAt).to.be.a('string'); }));",
              "pm.test('exactly the four inner cells remain active', () => pm.expect(areas.filter(a => a.isActive).map(a => a.gridRef).sort()).to.eql(['B2','B3','C2','C3']));",
              "pm.test('generated cells do not overlap', () => { const active=areas.filter(a=>a.isActive); for(let i=0;i<active.length;i++) for(let j=i+1;j<active.length;j++){ const overlap=active[i].minLat < active[j].maxLat && active[i].maxLat > active[j].minLat && active[i].minLng < active[j].maxLng && active[i].maxLng > active[j].minLng; pm.expect(overlap, `${active[i].gridRef}/${active[j].gridRef}`).to.eql(false); } });",
              'const active = areas.filter(a => a.isActive).sort((a,b) => a.gridRef.localeCompare(b.gridRef));',
              'active.forEach((a,i) => { pm.environment.set(`activeAreaId${i+1}`, a.id); pm.environment.set(`activeAreaLat${i+1}`, a.centerLat); pm.environment.set(`activeAreaLng${i+1}`, a.centerLng); pm.environment.set(`activeAreaName${i+1}`, a.name); });',
              "pm.environment.set('allNamedAreas', JSON.stringify(areas));",
            ]),
          },
        ),
        request(
          'Verify every zone centre returns its matching address',
          'GET',
          '/geo/reverse-geocode?lat={{activeAreaLat1}}&lng={{activeAreaLng1}}',
          {
            tests: ok(200, [
              "const areas = JSON.parse(pm.environment.get('allNamedAreas'));",
              "const baseUrl = pm.environment.get('baseUrl');",
              "areas.forEach(area => pm.sendRequest(`${baseUrl}/geo/reverse-geocode?lat=${area.centerLat}&lng=${area.centerLng}`, (error, result) => { pm.test(`address matches ${area.gridRef} ${area.name}`, () => { pm.expect(error).to.eql(null); pm.expect(result.code).to.eql(200); const payload=result.json().data; pm.expect(payload.addressLine).to.include(area.name); pm.expect(payload.cityCandidates).to.include('Indore'); if(area.isActive){ pm.expect(payload.area.areaId).to.eql(area.id); pm.expect(payload.area.areaName).to.eql(area.name); } else { pm.expect(payload.area).to.eql(null); } }); }));",
            ]),
          },
        ),
        request(
          'Refresh one persisted zone address',
          'POST',
          '/admin/areas/{{activeAreaId1}}/refresh-address',
          {
            auth: admin,
            tests: ok(201, [
              "pm.test('refreshed Google address still matches zone centre', () => { pm.expect(responseBody.data.addressLine).to.include(pm.environment.get('activeAreaName1')); pm.expect(responseBody.data.addressProvider).to.eql('google'); });",
            ]),
          },
        ),
      ],
    },
    {
      name: '3 — Manual area administration',
      item: [
        request(
          'Reject null essential fields for manual zone creation',
          'POST',
          '/admin/areas',
          {
            auth: admin,
            body: {
              cityId: ids.manualCity,
              name: null,
              minLat: null,
              maxLat: 22.72,
              minLng: 75.84,
              maxLng: 75.86,
            },
            tests: rejected(400, undefined, [
              "pm.test('required null fields are identified', () => { const text=JSON.stringify(responseBody.errors); pm.expect(text).to.include('name'); pm.expect(text).to.include('minLat'); });",
            ]),
          },
        ),
        request(
          'Bulk-create adjacent manual zones',
          'POST',
          '/admin/areas/bulk',
          {
            auth: admin,
            body: {
              cityId: ids.manualCity,
              areas: [
                {
                  name: 'Manual West',
                  minLat: 22.7,
                  maxLat: 22.72,
                  minLng: 75.84,
                  maxLng: 75.86,
                },
                {
                  name: 'Manual East',
                  minLat: 22.7,
                  maxLat: 22.72,
                  minLng: 75.86,
                  maxLng: 75.88,
                },
              ],
            },
            tests: ok(201, [
              "pm.environment.set('manualAreaId', responseBody.data[0].id);",
              "pm.test('bulk operation creates two Google-addressed zones', () => { pm.expect(responseBody.data).to.have.length(2); responseBody.data.forEach(area => { pm.expect(area.addressStatus).to.eql('resolved'); pm.expect(area.addressLine).to.be.a('string').and.not.empty; pm.expect(area.addressProvider).to.eql('google'); }); });",
            ]),
          },
        ),
        request('Create one manual zone', 'POST', '/admin/areas', {
          auth: admin,
          body: {
            cityId: ids.manualCity,
            name: 'Manual North',
            minLat: 22.72,
            maxLat: 22.74,
            minLng: 75.84,
            maxLng: 75.88,
          },
          tests: ok(201, [
            "pm.test('manual area is complete with Google address on creation', () => { pm.expect(responseBody.data.nameSource).to.eql('manual'); pm.expect(responseBody.data.addressStatus).to.eql('resolved'); pm.expect(responseBody.data.addressLine).to.be.a('string').and.not.empty; pm.expect(responseBody.data.addressProvider).to.eql('google'); }); ",
          ]),
        }),
        request(
          'Confirm area name as an admin-reviewed decision',
          'PATCH',
          '/admin/areas/{{activeAreaId1}}',
          {
            auth: admin,
            body: { name: '{{activeAreaName1}}' },
            tests: ok(200, [
              "pm.test('accepted name is now manual', () => pm.expect(responseBody.data.nameSource).to.eql('manual')); ",
            ]),
          },
        ),
        request(
          'Check manual-zone overlaps',
          'GET',
          '/admin/areas/{{manualAreaId}}/overlaps',
          {
            auth: admin,
            tests: ok(200, [
              "pm.test('touching edges are not overlaps', () => pm.expect(responseBody.data).to.eql([]));",
            ]),
          },
        ),
      ],
    },
    {
      name: '4 — Professional posting and service matrix',
      item: [
        ...[1, 2, 3, 4].map((n) =>
          request(
            `Assign Indore professional to active zone ${n}`,
            'POST',
            `/admin/areas/{{activeAreaId${n}}}/pros`,
            {
              auth: admin,
              body: { proId: ids.pro, isActive: true },
              tests: ok(201),
            },
          ),
        ),
        request(
          'Reject cross-city professional posting',
          'POST',
          '/admin/areas/{{activeAreaId1}}/pros',
          {
            auth: admin,
            body: { proId: ids.bhopalPro, isActive: true },
            tests: rejected(409, 'PRO_AREA_CITY_MISMATCH'),
          },
        ),
        request(
          'Reject Bhopal-scoped admin reading an Indore zone',
          'GET',
          '/admin/areas/{{activeAreaId1}}/services',
          {
            auth: 'scopedAdminToken',
            tests: rejected(403),
          },
        ),
        request(
          'List professionals in a zone',
          'GET',
          '/admin/areas/{{activeAreaId1}}/pros',
          {
            auth: admin,
            tests: ok(200, [
              "pm.test('assigned Pro is returned', () => pm.expect(responseBody.data.map(p => p.id)).to.include(pm.environment.get('proId'))); ",
            ]),
          },
        ),
        request(
          'List zones assigned to a professional',
          'GET',
          '/admin/areas/by-pro/{{proId}}',
          {
            auth: admin,
            tests: ok(200, [
              "pm.test('Pro has four active Indore zones', () => { pm.expect(responseBody.data).to.have.length(4); pm.expect(new Set(responseBody.data.map(a=>a.cityName))).to.eql(new Set(['Indore'])); });",
            ]),
          },
        ),
        request(
          'Enable one service in first zone',
          'POST',
          '/admin/areas/{{activeAreaId1}}/services',
          {
            auth: admin,
            body: { serviceId: ids.service, isActive: true },
            tests: ok(201),
          },
        ),
        request(
          'List services in first zone',
          'GET',
          '/admin/areas/{{activeAreaId1}}/services',
          {
            auth: admin,
            tests: ok(200, [
              "pm.test('service is active', () => pm.expect(responseBody.data.some(s => s.serviceId === pm.environment.get('serviceId') && s.isActive)).to.eql(true));",
            ]),
          },
        ),
        request(
          'Replace second zone service list',
          'PUT',
          '/admin/areas/{{activeAreaId2}}/services',
          {
            auth: admin,
            body: { serviceIds: [ids.service, ids.secondService] },
            tests: ok(200),
          },
        ),
        request(
          'Copy service list to third zone',
          'POST',
          '/admin/areas/{{activeAreaId3}}/services/copy',
          {
            auth: admin,
            body: { sourceAreaId: '{{activeAreaId2}}' },
            tests: ok(201),
          },
        ),
        request(
          'Enable service across all active zones',
          'POST',
          '/admin/areas/by-service/{{serviceId}}',
          {
            auth: admin,
            body: {
              areaIds: [
                '{{activeAreaId1}}',
                '{{activeAreaId2}}',
                '{{activeAreaId3}}',
                '{{activeAreaId4}}',
              ],
              isActive: true,
            },
            tests: ok(201),
          },
        ),
        request(
          'Read city service matrix',
          'GET',
          '/admin/areas/service-matrix?cityId={{cityId}}',
          {
            auth: admin,
            tests: ok(200, [
              "pm.test('matrix includes all zones and configured service', () => pm.expect(JSON.stringify(responseBody.data)).to.include(pm.environment.get('serviceId'))); ",
            ]),
          },
        ),
        request(
          'Check booking enforcement readiness',
          'GET',
          '/admin/areas/enforcement?cityId={{cityId}}',
          {
            auth: admin,
            tests: ok(200, [
              "pm.test('mapped city is ready but not enabled yet', () => { pm.expect(responseBody.data.ready).to.eql(true); pm.expect(responseBody.data.enabled).to.eql(false); pm.expect(responseBody.data.missingAddresses).to.eql([]); pm.expect(responseBody.data.unconfiguredAreas).to.eql([]); pm.expect(responseBody.data.unstaffed).to.eql([]); });",
            ]),
          },
        ),
        request(
          'Enable booking area-service enforcement',
          'PUT',
          '/admin/areas/enforcement',
          {
            auth: admin,
            body: { cityId: ids.city, isEnabled: true },
            tests: ok(200, [
              "pm.test('booking gate enabled after readiness checks', () => { pm.expect(responseBody.data.ready).to.eql(true); pm.expect(responseBody.data.enabled).to.eql(true); });",
            ]),
          },
        ),
        request(
          'Confirm booking enforcement persisted',
          'GET',
          '/admin/areas/enforcement?cityId={{cityId}}',
          {
            auth: admin,
            tests: ok(200, [
              "pm.test('city booking gate remains enabled', () => pm.expect(responseBody.data.enabled).to.eql(true));",
            ]),
          },
        ),
      ],
    },
    {
      name: '5 — Public/customer coordinate resolution',
      item: [
        request(
          'Resolve active Indore coordinate',
          'GET',
          '/geo/serviceability?lat={{activeAreaLat1}}&lng={{activeAreaLng1}}',
          {
            tests: ok(200, [
              "pm.test('coordinate resolves to expected grid zone', () => { pm.expect(responseBody.data.serviceable).to.eql(true); pm.expect(responseBody.data.area.areaId).to.eql(pm.environment.get('activeAreaId1')); pm.expect(responseBody.data.area.areaName).to.eql(pm.environment.get('activeAreaName1')); });",
            ]),
          },
        ),
        request(
          'Resolve service at active Indore coordinate',
          'GET',
          '/geo/serviceability?lat={{activeAreaLat1}}&lng={{activeAreaLng1}}&serviceId={{serviceId}}',
          {
            tests: ok(200, [
              "pm.test('configured service is available', () => pm.expect(responseBody.data.serviceable).to.eql(true));",
            ]),
          },
        ),
        request(
          'Coordinate-filtered catalogue',
          'GET',
          '/geo/catalog?lat={{activeAreaLat1}}&lng={{activeAreaLng1}}',
          {
            tests: ok(200, [
              "pm.test('catalogue uses expected zone and flags configured service', () => { pm.expect(responseBody.data.area.areaId).to.eql(pm.environment.get('activeAreaId1')); const service=responseBody.data.services.find(s=>s.id===pm.environment.get('serviceId')); pm.expect(service.isAvailable).to.eql(true); });",
            ]),
          },
        ),
        request(
          'List public zones for a service',
          'GET',
          '/geo/services/{{serviceId}}/areas',
          {
            tests: ok(200, [
              "pm.test('public response exposes four active zones only', () => { pm.expect(responseBody.data).to.have.length(4); responseBody.data.forEach(a => { pm.expect(a.cityName).to.eql('Indore'); pm.expect(a).not.to.have.property('gridRef'); }); });",
            ]),
          },
        ),
        request(
          'Reverse-geocode customer pin',
          'GET',
          '/geo/reverse-geocode?lat={{activeAreaLat1}}&lng={{activeAreaLng1}}',
          {
            tests: ok(200, [
              "pm.test('address and internal zone agree', () => { pm.expect(responseBody.data.addressLine).to.include(pm.environment.get('activeAreaName1')); pm.expect(responseBody.data.cityCandidates).to.include('Indore'); pm.expect(responseBody.data.area.areaId).to.eql(pm.environment.get('activeAreaId1')); });",
            ]),
          },
        ),
        request(
          'Resolve pruned outside coordinate as unavailable',
          'GET',
          '/geo/serviceability?lat=22.688983&lng=75.829740',
          {
            tests: ok(200, [
              "pm.test('deactivated outer cell cannot resolve', () => { pm.expect(responseBody.data.serviceable).to.eql(false); pm.expect(responseBody.data.code).to.eql('LOCATION_NOT_SERVICEABLE'); pm.expect(responseBody.data.area).to.eql(null); });",
            ]),
          },
        ),
        request(
          'Customer reverse-geocode compatibility endpoint',
          'GET',
          '/customers/me/addresses/reverse-geocode?pinLat={{activeAreaLat1}}&pinLng={{activeAreaLng1}}',
          {
            auth: customer,
            tests: ok(200, [
              "pm.test('customer address resolves to Indore', () => { pm.expect(responseBody.data.addressLine).to.include(pm.environment.get('activeAreaName1')); pm.expect(responseBody.data.cityId).to.eql(pm.environment.get('cityId')); });",
            ]),
          },
        ),
        request(
          'Add customer address from resolved pin',
          'POST',
          '/customers/me/addresses',
          {
            auth: customer,
            body: {
              label: 'home',
              addressLine: '{{activeAreaName1}}, Indore, Madhya Pradesh, India',
              landmark: 'Postman geo fixture',
              pinLat: '{{activeAreaLat1}}',
              pinLng: '{{activeAreaLng1}}',
            },
            tests: ok(201, [
              "pm.environment.set('addressId', responseBody.data.id);",
              "pm.test('first saved address is default and belongs to Indore', () => { pm.expect(responseBody.data.cityId).to.eql(pm.environment.get('cityId')); pm.expect(responseBody.data.isDefault).to.eql(true); });",
            ]),
          },
        ),
        request(
          'List saved customer addresses',
          'GET',
          '/customers/me/addresses',
          {
            auth: customer,
            tests: ok(200, [
              "pm.test('saved address is listed', () => pm.expect(responseBody.data.map(a=>a.id)).to.include(pm.environment.get('addressId'))); ",
            ]),
          },
        ),
        request(
          'Update saved customer address',
          'PATCH',
          '/customers/me/addresses/{{addressId}}',
          {
            auth: customer,
            body: { landmark: 'Updated Postman landmark' },
            tests: ok(200, [
              "pm.test('landmark updated', () => pm.expect(responseBody.data.landmark).to.eql('Updated Postman landmark')); ",
            ]),
          },
        ),
        request(
          'Set saved customer address as default',
          'PATCH',
          '/customers/me/addresses/{{addressId}}/default',
          {
            auth: customer,
            tests: ok(200, [
              "pm.test('address is default', () => pm.expect(responseBody.data.isDefault).to.eql(true)); ",
            ]),
          },
        ),
        request('Get customer best-known location', 'GET', '/geo/my-location', {
          auth: customer,
          tests: ok(200, [
            "pm.test('saved pin re-resolves to current zone', () => { pm.expect(responseBody.data.source).to.eql('default_address'); pm.expect(responseBody.data.area.areaId).to.eql(pm.environment.get('activeAreaId1')); });",
          ]),
        }),
        request(
          'Check customer city serviceability',
          'GET',
          '/customers/me/serviceability?cityId={{cityId}}',
          {
            auth: customer,
            tests: ok(200, [
              "pm.test('Indore city is active', () => pm.expect(responseBody.data.serviceable).to.eql(true)); ",
            ]),
          },
        ),
        request(
          'Delete saved customer address',
          'DELETE',
          '/customers/me/addresses/{{addressId}}',
          { auth: customer, tests: ok(200) },
        ),
      ],
    },
    {
      name: '6 — Professional live coordinate',
      item: [
        request(
          'Push approved professional live GPS coordinate',
          'POST',
          '/pros/me/location',
          {
            auth: pro,
            body: { lat: '{{activeAreaLat1}}', lng: '{{activeAreaLng1}}' },
            tests: ok(201, [
              "pm.test('Pro receives matching address and operational zone', () => { pm.expect(responseBody.data.addressLine).to.include(pm.environment.get('activeAreaName1')); pm.expect(responseBody.data.area.areaId).to.eql(pm.environment.get('activeAreaId1')); pm.expect(responseBody.data.area.areaName).to.eql(pm.environment.get('activeAreaName1')); });",
            ]),
            description:
              'Stores Redis GEO plus lastKnownLat/Lng and returns the reverse-geocoded address and internal operational zone for the same coordinate.',
          },
        ),
      ],
    },
    {
      name: '6A — Supplied Ring Road coordinate',
      description:
        'End-to-end verification for 22.724158, 75.905052. Independent reference: Ring Road, Indore, Madhya Pradesh 452001. The pin is inside the active city but east of the current pilot grid, so address/city resolution succeeds while internal area serviceability correctly remains false.',
      item: [
        request(
          'Reverse-geocode supplied Ring Road coordinate',
          'GET',
          `/geo/reverse-geocode?lat=${suppliedPin.lat}&lng=${suppliedPin.lng}`,
          {
            tests: ok(200, [
              "pm.test('human address resolves without inventing a zone', () => { pm.expect(responseBody.data.addressLine).to.include('Ring Road'); pm.expect(responseBody.data.cityCandidates).to.include('Indore'); pm.expect(responseBody.data.stateName).to.eql('Madhya Pradesh'); pm.expect(responseBody.data.postalCode).to.eql('452001'); pm.expect(responseBody.data.provider).to.eql('google'); pm.expect(responseBody.data.area).to.eql(null); });",
            ]),
          },
        ),
        request(
          'Check supplied coordinate serviceability',
          'GET',
          `/geo/serviceability?lat=${suppliedPin.lat}&lng=${suppliedPin.lng}`,
          {
            tests: ok(200, [
              "pm.test('pin is outside the operational grid', () => { pm.expect(responseBody.data.serviceable).to.eql(false); pm.expect(responseBody.data.area).to.eql(null); pm.expect(responseBody.data.code).to.eql('LOCATION_NOT_SERVICEABLE'); });",
            ]),
          },
        ),
        request(
          'Check service at supplied coordinate',
          'GET',
          `/geo/serviceability?lat=${suppliedPin.lat}&lng=${suppliedPin.lng}&serviceId={{serviceId}}`,
          {
            tests: ok(200, [
              "pm.test('service cannot bypass missing area', () => { pm.expect(responseBody.data.serviceable).to.eql(false); pm.expect(responseBody.data.area).to.eql(null); pm.expect(responseBody.data.code).to.eql('LOCATION_NOT_SERVICEABLE'); });",
            ]),
          },
        ),
        request(
          'Browse catalogue at supplied coordinate',
          'GET',
          `/geo/catalog?lat=${suppliedPin.lat}&lng=${suppliedPin.lng}`,
          {
            tests: ok(200, [
              "pm.test('catalogue stays visible but unavailable', () => { pm.expect(responseBody.data.serviceable).to.eql(false); pm.expect(responseBody.data.area).to.eql(null); pm.expect(responseBody.data.code).to.eql('LOCATION_NOT_SERVICEABLE'); pm.expect(responseBody.data.services).to.be.an('array').and.not.empty; responseBody.data.services.forEach(service => pm.expect(service.isAvailable).to.eql(false)); });",
            ]),
          },
        ),
        request(
          'Customer preview supplied coordinate',
          'GET',
          `/customers/me/addresses/reverse-geocode?pinLat=${suppliedPin.lat}&pinLng=${suppliedPin.lng}`,
          {
            auth: customer,
            tests: ok(200, [
              "pm.test('city-level address resolution succeeds', () => { pm.expect(responseBody.data.addressLine).to.include('Ring Road'); pm.expect(responseBody.data.cityId).to.eql(pm.environment.get('cityId')); pm.expect(responseBody.data.cityName).to.eql('Indore'); pm.expect(responseBody.data.serviceable).to.eql(true); });",
            ]),
          },
        ),
        request(
          'Save supplied coordinate as customer address',
          'POST',
          '/customers/me/addresses',
          {
            auth: customer,
            body: {
              label: 'other',
              addressLine: 'Ring Road, Indore, Madhya Pradesh 452001, India',
              landmark: 'Supplied coordinate verification',
              pinLat: suppliedPin.lat,
              pinLng: suppliedPin.lng,
            },
            tests: ok(201, [
              "pm.environment.set('suppliedAddressId', responseBody.data.id);",
              "pm.test('address is saved in Indore at the exact pin', () => { pm.expect(responseBody.data.cityId).to.eql(pm.environment.get('cityId')); pm.expect(responseBody.data.pinLat).to.eql(22.724158); pm.expect(responseBody.data.pinLng).to.eql(75.905052); });",
            ]),
          },
        ),
        request(
          'Resolve customer best-known supplied coordinate',
          'GET',
          '/geo/my-location',
          {
            auth: customer,
            tests: ok(200, [
              "pm.test('saved city address remains outside operational grid', () => { pm.expect(responseBody.data.source).to.eql('default_address'); pm.expect(responseBody.data.address.pinLat).to.eql(22.724158); pm.expect(responseBody.data.address.pinLng).to.eql(75.905052); pm.expect(responseBody.data.area).to.eql(null); pm.expect(responseBody.data.serviceable).to.eql(false); pm.expect(responseBody.data.code).to.eql('LOCATION_NOT_SERVICEABLE'); });",
            ]),
          },
        ),
        request(
          'Push professional supplied coordinate',
          'POST',
          '/pros/me/location',
          {
            auth: pro,
            body: suppliedPin,
            tests: ok(201, [
              "pm.test('professional GPS stores and resolves the same address', () => { pm.expect(responseBody.data.lat).to.eql(22.724158); pm.expect(responseBody.data.lng).to.eql(75.905052); pm.expect(responseBody.data.addressLine).to.include('Ring Road'); pm.expect(responseBody.data.postalCode).to.eql('452001'); pm.expect(responseBody.data.provider).to.eql('google'); pm.expect(responseBody.data.area).to.eql(null); });",
            ]),
          },
        ),
        request(
          'Delete supplied customer address',
          'DELETE',
          '/customers/me/addresses/{{suppliedAddressId}}',
          { auth: customer, tests: ok(200) },
        ),
      ],
    },
    {
      name: '7 — Destructive grid lifecycle (run last)',
      item: [
        request(
          'Refuse regeneration while booking enforcement is active',
          'POST',
          '/admin/areas/regenerate',
          {
            auth: admin,
            body: { cityId: ids.city, ...pilotBox },
            tests: rejected(409, 'AREA_ENFORCEMENT_ENABLED'),
          },
        ),
        request(
          'Disable booking enforcement before replacing map',
          'PUT',
          '/admin/areas/enforcement',
          {
            auth: admin,
            body: { cityId: ids.city, isEnabled: false },
            tests: ok(200, [
              "pm.test('booking gate disabled', () => pm.expect(responseBody.data.enabled).to.eql(false));",
            ]),
          },
        ),
        request(
          'Regenerate Indore pilot grid',
          'POST',
          '/admin/areas/regenerate',
          {
            auth: admin,
            body: { cityId: ids.city, ...pilotBox },
            tests: ok(201, [
              "pm.test('unused old grid replaced cleanly and reports pending enrichment', () => { pm.expect(responseBody.data.retired).to.eql(0); pm.expect(responseBody.data.deleted).to.eql(16); pm.expect(responseBody.data.created).to.have.length(16); responseBody.data.created.forEach(area => pm.expect(area.addressStatus).to.eql('pending')); });",
            ]),
            description:
              'Destructive by design and therefore last. In this isolated fixture no booking references an old cell, so all 16 old cells are deleted and replaced.',
          },
        ),
        request(
          'Start address and naming enrichment for regenerated grid',
          'POST',
          '/admin/areas/suggest-names?cityId={{cityId}}',
          {
            auth: admin,
            tests: ok(201, [
              "pm.test('all regenerated cells queued', () => pm.expect(responseBody.data.queued).to.eql(16));",
            ]),
          },
        ),
        request(
          'Wait for regenerated grid enrichment',
          'GET',
          '/admin/areas/naming-progress?cityId={{cityId}}',
          {
            auth: admin,
            prerequest: [
              '// Allow the asynchronous Google-compatible naming pass to settle.',
              'setTimeout(() => {}, 1000);',
            ],
            tests: ok(200, [
              "pm.test('regenerated grid enrichment completed', () => { pm.expect(responseBody.data.running).to.eql(false); pm.expect(responseBody.data.pending).to.eql(0); });",
            ]),
          },
        ),
        request(
          'Audit regenerated grid has no null essential addresses',
          'GET',
          '/admin/areas?cityId={{cityId}}&includeInactive=true',
          {
            auth: admin,
            tests: ok(200, [
              "pm.test('every regenerated Google address is resolved', () => { pm.expect(responseBody.data).to.have.length(16); responseBody.data.forEach(area => { pm.expect(area.addressStatus, area.gridRef).to.eql('resolved'); pm.expect(area.addressLine, area.gridRef).to.be.a('string').and.not.empty; pm.expect(area.addressProvider, area.gridRef).to.eql('google'); pm.expect(area.addressUpdatedAt, area.gridRef).to.be.a('string'); }); });",
            ]),
          },
        ),
      ],
    },
  ],
};

const environment = {
  id: '331471b4-f9f4-4df2-93be-1c82f7d2ff15',
  name: 'Homingo Geo — Indore local mock',
  values: [
    { key: 'baseUrl', value: 'http://127.0.0.1:53013/api/v1', enabled: true },
    { key: 'adminToken', value: '', enabled: true, type: 'secret' },
    { key: 'scopedAdminToken', value: '', enabled: true, type: 'secret' },
    { key: 'customerToken', value: '', enabled: true, type: 'secret' },
    { key: 'proToken', value: '', enabled: true, type: 'secret' },
    {
      key: 'registrationPhone',
      value: '7828241099',
      enabled: true,
      type: 'default',
    },
    {
      key: 'registrationOtp',
      value: '123456',
      enabled: true,
      type: 'secret',
    },
    {
      key: 'registrationProviderRef',
      value: '',
      enabled: true,
      type: 'secret',
    },
    {
      key: 'registrationAccessToken',
      value: '',
      enabled: true,
      type: 'secret',
    },
    {
      key: 'registrationRefreshToken',
      value: '',
      enabled: true,
      type: 'secret',
    },
    { key: 'cityId', value: ids.city, enabled: true },
    { key: 'serviceId', value: ids.service, enabled: true },
    { key: 'secondServiceId', value: ids.secondService, enabled: true },
    { key: 'proId', value: ids.pro, enabled: true },
  ],
  _postman_variable_scope: 'environment',
  _postman_exported_at: new Date().toISOString(),
  _postman_exported_using: 'Homingo repository generator',
};

await mkdir(out, { recursive: true });
await writeFile(
  resolve(out, 'Homingo-Geo-Indore.postman_collection.json'),
  `${json(collection)}\n`,
);
await writeFile(
  resolve(out, 'Homingo-Geo-Indore.postman_environment.json'),
  `${json(environment)}\n`,
);
console.log('Generated Postman Geo collection and Indore environment.');
