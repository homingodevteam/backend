# Homingo Geo API response evidence

Generated: 2026-08-13T09:01:25.753Z

This report lists the real HTTP responses captured by Newman against the isolated Homingo application stack. Authorization and cookie headers are removed. Full request and response bodies are in `Homingo-Geo-Indore.responses.json`.

- Requests: 86
- Assertions: 216
- Failed assertions: 0

|   # | Method | Request                                                  | Status | Time (ms) | Tests |
| --: | :----: | -------------------------------------------------------- | -----: | --------: | ----: |
|   1 |  POST  | Request registration OTP                                 |    201 |        63 |  Pass |
|   2 |  POST  | Verify registration OTP                                  |    201 |       180 |  Pass |
|   3 |  GET   | List cities                                              |    200 |        77 |  Pass |
|   4 |  POST  | Add a city                                               |    201 |        32 |  Pass |
|   5 | PATCH  | Update city metadata                                     |    200 |        41 |  Pass |
|   6 | PATCH  | Activate city with explicit no-supply acknowledgement    |    200 |        17 |  Pass |
|   7 |  GET   | Fetch official Indore city bounds                        |    200 |       100 |  Pass |
|   8 |  POST  | Preview pilot grid without writing                       |    201 |        15 |  Pass |
|   9 |  POST  | Generate grid from centre (legacy supported path)        |    201 |        88 |  Pass |
|  10 |  POST  | Generate 4x4 Indore pilot grid for a box                 |    201 |        82 |  Pass |
|  11 |  GET   | List all active generated zones                          |    200 |        14 |  Pass |
|  12 |  POST  | Dry-run removal of zones beyond operational boundary     |    201 |        44 |  Pass |
|  13 |  POST  | Deactivate zones beyond operational boundary             |    201 |        49 |  Pass |
|  14 |  POST  | Start zone naming from reverse-geocoded centres          |    201 |        24 |  Pass |
|  15 |  GET   | Wait for and verify naming completion                    |    200 |        20 |  Pass |
|  16 |  GET   | Audit names, active boundary and grid geometry           |    200 |        14 |  Pass |
|  17 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  18 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  19 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  20 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  21 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  22 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  23 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  24 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  25 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  26 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  27 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  28 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  29 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  30 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  31 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  32 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  33 |  GET   | Verify every zone centre returns its matching address    |    200 |       372 |  Pass |
|  34 |  POST  | Refresh one persisted zone address                       |    201 |        23 |  Pass |
|  35 |  POST  | Reject null essential fields for manual zone creation    |    400 |        12 |  Pass |
|  36 |  POST  | Bulk-create adjacent manual zones                        |    201 |        45 |  Pass |
|  37 |  POST  | Create one manual zone                                   |    201 |        21 |  Pass |
|  38 | PATCH  | Confirm area name as an admin-reviewed decision          |    200 |        15 |  Pass |
|  39 |  GET   | Check manual-zone overlaps                               |    200 |        13 |  Pass |
|  40 |  POST  | Assign Indore professional to active zone 1              |    201 |        30 |  Pass |
|  41 |  POST  | Assign Indore professional to active zone 2              |    201 |        16 |  Pass |
|  42 |  POST  | Assign Indore professional to active zone 3              |    201 |        21 |  Pass |
|  43 |  POST  | Assign Indore professional to active zone 4              |    201 |       110 |  Pass |
|  44 |  POST  | Reject cross-city professional posting                   |    409 |       289 |  Pass |
|  45 |  GET   | Reject Bhopal-scoped admin reading an Indore zone        |    403 |        24 |  Pass |
|  46 |  GET   | List professionals in a zone                             |    200 |        14 |  Pass |
|  47 |  GET   | List zones assigned to a professional                    |    200 |        19 |  Pass |
|  48 |  POST  | Enable one service in first zone                         |    201 |        56 |  Pass |
|  49 |  GET   | List services in first zone                              |    200 |        18 |  Pass |
|  50 |  PUT   | Replace second zone service list                         |    200 |        45 |  Pass |
|  51 |  POST  | Copy service list to third zone                          |    201 |        46 |  Pass |
|  52 |  POST  | Enable service across all active zones                   |    201 |       150 |  Pass |
|  53 |  GET   | Read city service matrix                                 |    200 |        22 |  Pass |
|  54 |  GET   | Check booking enforcement readiness                      |    200 |        38 |  Pass |
|  55 |  PUT   | Enable booking area-service enforcement                  |    200 |        39 |  Pass |
|  56 |  GET   | Confirm booking enforcement persisted                    |    200 |        27 |  Pass |
|  57 |  GET   | Resolve active Indore coordinate                         |    200 |         7 |  Pass |
|  58 |  GET   | Resolve service at active Indore coordinate              |    200 |        21 |  Pass |
|  59 |  GET   | Coordinate-filtered catalogue                            |    200 |        35 |  Pass |
|  60 |  GET   | List public zones for a service                          |    200 |        11 |  Pass |
|  61 |  GET   | Reverse-geocode customer pin                             |    200 |         8 |  Pass |
|  62 |  GET   | Resolve pruned outside coordinate as unavailable         |    200 |         7 |  Pass |
|  63 |  GET   | Customer reverse-geocode compatibility endpoint          |    200 |        11 |  Pass |
|  64 |  POST  | Add customer address from resolved pin                   |    201 |        58 |  Pass |
|  65 |  GET   | List saved customer addresses                            |    200 |        21 |  Pass |
|  66 | PATCH  | Update saved customer address                            |    200 |        21 |  Pass |
|  67 | PATCH  | Set saved customer address as default                    |    200 |        21 |  Pass |
|  68 |  GET   | Get customer best-known location                         |    200 |        22 |  Pass |
|  69 |  GET   | Check customer city serviceability                       |    200 |        25 |  Pass |
|  70 | DELETE | Delete saved customer address                            |    200 |        43 |  Pass |
|  71 |  POST  | Push approved professional live GPS coordinate           |    201 |        37 |  Pass |
|  72 |  GET   | Reverse-geocode supplied Ring Road coordinate            |    200 |        13 |  Pass |
|  73 |  GET   | Check supplied coordinate serviceability                 |    200 |         6 |  Pass |
|  74 |  GET   | Check service at supplied coordinate                     |    200 |        20 |  Pass |
|  75 |  GET   | Browse catalogue at supplied coordinate                  |    200 |         9 |  Pass |
|  76 |  GET   | Customer preview supplied coordinate                     |    200 |        12 |  Pass |
|  77 |  POST  | Save supplied coordinate as customer address             |    201 |        24 |  Pass |
|  78 |  GET   | Resolve customer best-known supplied coordinate          |    200 |        16 |  Pass |
|  79 |  POST  | Push professional supplied coordinate                    |    201 |        27 |  Pass |
|  80 | DELETE | Delete supplied customer address                         |    200 |        31 |  Pass |
|  81 |  POST  | Refuse regeneration while booking enforcement is active  |    409 |        26 |  Pass |
|  82 |  PUT   | Disable booking enforcement before replacing map         |    200 |        45 |  Pass |
|  83 |  POST  | Regenerate Indore pilot grid                             |    201 |       114 |  Pass |
|  84 |  POST  | Start address and naming enrichment for regenerated grid |    201 |        15 |  Pass |
|  85 |  GET   | Wait for regenerated grid enrichment                     |    200 |        18 |  Pass |
|  86 |  GET   | Audit regenerated grid has no null essential addresses   |    200 |        15 |  Pass |
