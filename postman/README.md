# Homingo Geo Postman collection

Postman cloud collection: [Homingo Geo — Indore complete endpoint verification](https://go.postman.co/collection/57227418-f6d2a8d5-0c97-40d2-a60d-fc9e69e4b4a9)

Workspace: [Homingo's Workspace](https://go.postman.co/workspace/e1064f08-eb8a-4469-8b63-9532a4690b82)

Import these two files into Postman:

- `Homingo-Geo-Indore.postman_collection.json`
- `Homingo-Geo-Indore.postman_environment.json`

The collection documents and verifies the full operational Geo surface:

- customer OTP registration using a configurable mock code, with all OTP and
  token values redacted from retained evidence;
- city creation, editing, activation and listing;
- city-bound lookup, grid preview, both grid generators, bulk/manual zones,
  pruning, renaming, overlap checks and regeneration;
- per-zone services, the service matrix, copying and bulk service assignment;
- assigning/removing a professional and reading both posting directions;
- rejecting cross-city professional assignments and enforcing scoped-admin
  city boundaries;
- persisted centre addresses, address refresh and booking-enforcement
  readiness/configuration;
- public resolution, reverse geocoding, catalogue and service-area discovery;
- customer address reverse geocoding and address lifecycle;
- professional live GPS ingestion.

## Automated Indore run

From PowerShell at the repository root:

```powershell
.\test\manual\run-geo-postman.ps1
```

The runner creates a disposable PostgreSQL cluster, runs every migration,
starts the repository's Redis fixture and a deterministic Google Geocoding
API-compatible Indore server, starts Homingo, injects short-lived JWTs into a temporary copy
of the environment, and executes the Postman collection with Newman. These are
real HTTP requests to the built Nest application (not mocked controllers); the
Google adapter is real while its external HTTP server uses deterministic test data. The run
never connects to the development database or a Postman cloud account.

After every run it retains sanitized evidence in `postman/reports/`:

- `Homingo-Geo-Indore.summary.md` lists every request, status, duration and
  assertion result;
- `Homingo-Geo-Indore.responses.json` contains the request and response bodies.

Authorization and cookie headers are removed from these reports.
Bodyless methods are recorded with `hasBody: false`; the `body` property is
omitted instead of being shown as an ambiguous `null`.
The same sanitized response bodies are attached to every collection request as
saved examples, so Postman documentation and mock tooling can render them.

The 4x4 pilot grid intentionally extends beyond a smaller operational boundary.
The collection first performs a dry run, then proves that 12 outer zones are
deactivated while the inner `B2`, `B3`, `C2`, and `C3` zones remain active.
Each of all 16 grid centres is reverse-geocoded and checked against its stored
zone name; deactivated zones must return an address but no service-area match.
The collection also proves that the booking gate cannot be enabled before the
city is ready, can be enabled once coverage is complete, and prevents grid
regeneration while enabled.

## Running in the Postman desktop app

Set `baseUrl` and paste valid `adminToken`, `customerToken`, and `proToken`
values into the imported environment. Run folders in numeric order. Folder 7
regenerates the grid and is intentionally destructive, so use a disposable
database or a dedicated QA city.

The mock address server is deterministic test data, not a replacement for a
production geocoder. Production acceptance should repeat representative pins
against the configured Google Maps or Nominatim provider and display the
returned attribution.

## Regenerating the collection

The JSON files are generated from `scripts/generate-geo-postman.mjs`:

```powershell
node .\scripts\generate-geo-postman.mjs
```
