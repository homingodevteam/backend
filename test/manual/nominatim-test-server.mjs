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
