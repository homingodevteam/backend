import http from 'node:http';

const port = Number(process.env.TEST_NOMINATIM_PORT ?? 58080);

const locations = [
  {
    matches: (lat, lon) => Math.abs(lat - 22.7196) < 0.01 && Math.abs(lon - 75.8577) < 0.01,
    body: {
      display_name: 'Vijay Nagar, Indore, Madhya Pradesh, India',
      licence: 'Test fixture derived from OpenStreetMap response shape',
      address: { city: 'Indore', state: 'Madhya Pradesh' },
    },
  },
  {
    matches: (lat, lon) => Math.abs(lat - 19.076) < 0.01 && Math.abs(lon - 72.8777) < 0.01,
    body: {
      display_name: 'Fort, Mumbai, Maharashtra, India',
      licence: 'Test fixture derived from OpenStreetMap response shape',
      address: { city: 'Mumbai', state: 'Maharashtra' },
    },
  },
  {
    matches: (lat, lon) => Math.abs(lat - 28.6139) < 0.01 && Math.abs(lon - 77.209) < 0.01,
    body: {
      display_name: 'Connaught Place, New Delhi, Delhi, India',
      licence: 'Test fixture derived from OpenStreetMap response shape',
      address: { city: 'New Delhi', state: 'Delhi' },
    },
  },
  // --- Pins that land in the seeded Indore grid (module 13) -----------------
  // Reverse geocoding only has to yield the CITY; which area a pin falls in is
  // decided by the rectangles, not by this response. These exist so a scripted
  // run can put addresses in specific cells and exercise the area gate.
  {
    // Inside the seeded "Vijay Nagar" cell — lat [22.714, 22.768), lng [75.858, 75.916).
    matches: (lat, lon) => Math.abs(lat - 22.74) < 0.02 && Math.abs(lon - 75.89) < 0.02,
    body: {
      display_name: 'Vijay Nagar, Indore, Madhya Pradesh, India',
      licence: 'Test fixture derived from OpenStreetMap response shape',
      address: { city: 'Indore', state: 'Madhya Pradesh' },
    },
  },
  {
    // Inside the seeded "Rau" cell, which deliberately has the deep clean
    // switched OFF — the working SERVICE_NOT_AVAILABLE_IN_AREA fixture.
    matches: (lat, lon) => Math.abs(lat - 22.69) < 0.02 && Math.abs(lon - 75.83) < 0.02,
    body: {
      display_name: 'Rau, Indore, Madhya Pradesh, India',
      licence: 'Test fixture derived from OpenStreetMap response shape',
      address: { city: 'Indore', state: 'Madhya Pradesh' },
    },
  },
  {
    // A seeded, ACTIVE city with no areas drawn — so a booking there resolves
    // to a real city and a null area, which is a state the product will
    // genuinely be in every time a new city is opened.
    matches: (lat, lon) => Math.abs(lat - 23.2599) < 0.02 && Math.abs(lon - 77.4126) < 0.02,
    body: {
      display_name: 'MP Nagar, Bhopal, Madhya Pradesh, India',
      licence: 'Test fixture derived from OpenStreetMap response shape',
      address: { city: 'Bhopal', state: 'Madhya Pradesh' },
    },
  },
];

http
  .createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname !== '/reverse') {
      response.writeHead(404).end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const location = locations.find((entry) => entry.matches(lat, lon));
    response.writeHead(200).end(
      JSON.stringify(location?.body ?? { error: 'Unable to geocode' }),
    );
  })
  .listen(port, '127.0.0.1', () => {
    process.stdout.write(`test Nominatim listening on ${port}\n`);
  });
