import http from 'node:http';

const port = Number(process.env.TEST_NOMINATIM_PORT ?? 58081);
const originLat = 22.68;
const originLng = 75.82;
const latStep = 2 / 111.32;
const midLat = (22.68 + 22.7518) / 2;
const lngStep = 2 / (111.32 * Math.cos((midLat * Math.PI) / 180));
const localities = [
  ['Rau', 'CAT Road', 'Chandan Nagar', 'Airport Road'],
  ['Silicon City', 'Rajendra Nagar', 'Annapurna Road', 'Rajwada'],
  ['Bhawarkuan', 'Sapna Sangeeta', 'Palasia', 'Bengali Square'],
  ['Super Corridor', 'Mahalaxmi Nagar', 'Vijay Nagar', 'Scheme No 140'],
];

function localityFor(lat, lon) {
  if (Math.abs(lat - 22.724158) < 0.0002 && Math.abs(lon - 75.905052) < 0.0002) {
    return 'Ring Road';
  }
  const row = Math.floor((lat - originLat) / latStep);
  const col = Math.floor((lon - originLng) / lngStep);
  return localities[row]?.[col] ?? 'Indore';
}

function reverseBody(lat, lon) {
  const locality = localityFor(lat, lon);
  const suffix = String(Math.max(10, Math.min(99, Math.round((lat - 22.6) * 100)))).padStart(2, '0');
  const postcode = locality === 'Ring Road' ? '452001' : `4520${suffix}`;
  return {
    place_id: 1000 + Math.round(lat * 100) + Math.round(lon * 100),
    lat: String(lat),
    lon: String(lon),
    display_name: `${locality}, Indore, Madhya Pradesh ${postcode}, India`,
    licence: 'Deterministic Postman fixture in Nominatim response format',
    address: {
      suburb: locality,
      city: 'Indore',
      state: 'Madhya Pradesh',
      postcode,
      country: 'India',
      country_code: 'in',
    },
  };
}

function googleComponents(locality, postalCode) {
  return [
    { long_name: locality, short_name: locality, types: ['sublocality_level_1', 'sublocality'] },
    { long_name: 'Indore', short_name: 'Indore', types: ['locality'] },
    { long_name: 'Indore District', short_name: 'Indore', types: ['administrative_area_level_2'] },
    { long_name: 'Madhya Pradesh', short_name: 'MP', types: ['administrative_area_level_1'] },
    { long_name: postalCode, short_name: postalCode, types: ['postal_code'] },
    { long_name: 'India', short_name: 'IN', types: ['country'] },
  ];
}

function googleReverseBody(lat, lon) {
  const nominatim = reverseBody(lat, lon);
  return {
    status: 'OK',
    results: [{
      formatted_address: nominatim.display_name,
      address_components: googleComponents(
        nominatim.address.suburb,
        nominatim.address.postcode,
      ),
      types: ['street_address'],
      geometry: { location: { lat, lng: lon } },
    }],
  };
}

function googleCityBody() {
  return {
    status: 'OK',
    results: [{
      formatted_address: 'Indore, Madhya Pradesh, India',
      address_components: googleComponents('Indore', '452001'),
      types: ['locality', 'political'],
      geometry: {
        location: { lat: 22.7196, lng: 75.8577 },
        bounds: {
          southwest: { lat: 22.6131, lng: 75.7657 },
          northeast: { lat: 22.8349, lng: 75.9620 },
        },
      },
    }],
  };
}

http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  response.setHeader('Content-Type', 'application/json');

  if (url.pathname === '/search') {
    response.writeHead(200).end(JSON.stringify([{
      place_id: 9001,
      display_name: 'Indore, Madhya Pradesh, India',
      boundingbox: ['22.6131', '22.8349', '75.7657', '75.9620'],
      lat: '22.7196',
      lon: '75.8577',
    }]));
    return;
  }

  if (url.pathname === '/reverse') {
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      response.writeHead(400).end(JSON.stringify({ error: 'invalid coordinates' }));
      return;
    }
    response.writeHead(200).end(JSON.stringify(reverseBody(lat, lon)));
    return;
  }

  if (url.pathname === '/maps/api/geocode/json') {
    const latlng = url.searchParams.get('latlng');
    if (latlng) {
      const [lat, lon] = latlng.split(',').map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        response.writeHead(200).end(JSON.stringify({ status: 'INVALID_REQUEST', results: [] }));
        return;
      }
      response.writeHead(200).end(JSON.stringify(googleReverseBody(lat, lon)));
      return;
    }
    if (url.searchParams.get('address')) {
      response.writeHead(200).end(JSON.stringify(googleCityBody()));
      return;
    }
    response.writeHead(200).end(JSON.stringify({ status: 'INVALID_REQUEST', results: [] }));
    return;
  }

  response.writeHead(404).end(JSON.stringify({ error: 'not found' }));
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`Indore test Google/Nominatim geocoder listening on ${port}\n`);
});
