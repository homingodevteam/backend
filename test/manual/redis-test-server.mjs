import net from 'node:net';

const port = Number(process.env.TEST_REDIS_PORT ?? 56379);
const expiryScale = Number(process.env.TEST_REDIS_EXPIRY_SCALE ?? 1);
const values = new Map();
const expires = new Map();
/** GEO members, keyed `${key}:${member}` → { longitude, latitude }. */
const geo = new Map();
/** List values, keyed by list name — backs the dispatch queue. */
const lists = new Map();
/**
 * Sockets currently in subscriber mode, keyed by channel.
 *
 * Real Redis pub/sub is fire-and-forget with no persistence, which is exactly
 * what live tracking needs and exactly what makes it cheap to fake: deliver to
 * whoever is listening right now, forget everything else.
 */
const channels = new Map();

function live(key) {
  const until = expires.get(key);
  if (until && until <= Date.now()) {
    values.delete(key);
    expires.delete(key);
  }
  return values.has(key);
}

function bulk(value) {
  return value == null
    ? '$-1\r\n'
    : `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

function array(valuesToEncode) {
  return `*${valuesToEncode.length}\r\n${valuesToEncode.map((value) => bulk(value)).join('')}`;
}

function matchesPattern(value, pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`).test(value);
}

function parse(buffer) {
  const text = buffer.toString();
  const lines = text.split('\r\n');
  if (!text.startsWith('*')) return null;
  const count = Number(lines[0].slice(1));
  const args = [];
  let index = 1;
  for (let i = 0; i < count; i += 1) {
    index += 1;
    args.push(lines[index] ?? '');
    index += 1;
  }
  return args;
}

function execute(args) {
  const command = args[0]?.toLowerCase();
  if (command === 'ping') return '+PONG\r\n';
  if (command === 'echo') return bulk(args[1]);
  if (command === 'info') return bulk('# Server\r\nredis_version:7.0.0\r\n');
  if (command === 'client' || command === 'select') return '+OK\r\n';
  if (command === 'quit') return '+OK\r\n';
  if (command === 'get')
    return bulk(live(args[1]) ? values.get(args[1]) : null);
  if (command === 'set') {
    const key = args[1];
    const nx = args.some((arg) => arg.toLowerCase() === 'nx');
    if (nx && live(key)) return '$-1\r\n';
    values.set(key, args[2]);
    const ex = args.findIndex((arg) => arg.toLowerCase() === 'ex');
    if (ex >= 0)
      expires.set(key, Date.now() + Number(args[ex + 1]) * 1000 * expiryScale);
    return '+OK\r\n';
  }
  if (command === 'incr') {
    const next = (live(args[1]) ? Number(values.get(args[1])) : 0) + 1;
    values.set(args[1], String(next));
    return `:${next}\r\n`;
  }
  if (command === 'expire') {
    if (!live(args[1])) return ':0\r\n';
    expires.set(args[1], Date.now() + Number(args[2]) * 1000);
    return ':1\r\n';
  }
  if (command === 'ttl') {
    if (!live(args[1])) return ':-2\r\n';
    const until = expires.get(args[1]);
    return until
      ? `:${Math.max(0, Math.ceil((until - Date.now()) / 1000))}\r\n`
      : ':-1\r\n';
  }
  if (command === 'del') {
    let removed = 0;
    for (const key of args.slice(1)) {
      if (values.delete(key)) removed += 1;
      expires.delete(key);
    }
    return `:${removed}\r\n`;
  }
  if (command === 'scan') {
    const matchIndex = args.findIndex((arg) => arg.toLowerCase() === 'match');
    const pattern = matchIndex >= 0 ? args[matchIndex + 1] : '*';
    const keys = [...values.keys()].filter(
      (key) => live(key) && matchesPattern(key, pattern),
    );
    return `*2\r\n${bulk('0')}${array(keys)}`;
  }
  // RPUSH / LPOP / LLEN — the dispatch intake queue (module 5, feature 1).
  if (command === 'rpush') {
    const [, key, ...items] = args;
    const list = lists.get(key) ?? [];
    list.push(...items);
    lists.set(key, list);
    return `:${list.length}\r\n`;
  }
  if (command === 'lpop') {
    const [, key] = args;
    const list = lists.get(key) ?? [];
    const value = list.shift();
    lists.set(key, list);
    return value === undefined ? '$-1\r\n' : bulk(value);
  }
  if (command === 'llen') {
    const [, key] = args;
    return `:${(lists.get(key) ?? []).length}\r\n`;
  }
  // GEOADD key lng lat member — stored for real, because GEOPOS has to read
  // it back: the booking tracking view is the first caller that does.
  if (command === 'geoadd') {
    const [, key, longitude, latitude, member] = args;
    geo.set(`${key}:${member}`, { longitude, latitude });
    return ':1\r\n';
  }
  // GEOPOS key member [member ...] — an array of [lng, lat] pairs, with a
  // null entry for any member that has never reported.
  if (command === 'geopos') {
    const [, key, ...members] = args;
    const entries = members.map((member) => {
      const position = geo.get(`${key}:${member}`);
      if (!position) return '*-1\r\n';
      return `*2\r\n${bulk(position.longitude)}${bulk(position.latitude)}`;
    });
    return `*${entries.length}\r\n${entries.join('')}`;
  }
  if (command === 'zrem') {
    const [, key, member] = args;
    geo.delete(`${key}:${member}`);
    return ':1\r\n';
  }
  return '-ERR unsupported test command\r\n';
}

/**
 * PUBLISH / SUBSCRIBE, enough for the live-tracking fan-out.
 *
 * Handled outside `execute` because both are stateful per *connection* rather
 * than per keyspace: a subscriber holds its socket open and receives pushes it
 * never asked for, which the request/response shape above cannot express.
 *
 * Real Redis pub/sub is fire-and-forget with no persistence — which is exactly
 * what live tracking wants, and exactly what makes it cheap to fake: deliver to
 * whoever is listening right now, forget everything else.
 */
function handlePubSub(socket, args) {
  const command = args[0].toLowerCase();

  if (command === 'subscribe') {
    for (const channel of args.slice(1)) {
      if (!channels.has(channel)) channels.set(channel, new Set());
      channels.get(channel).add(socket);
      socket.write(
        `*3\r\n$9\r\nsubscribe\r\n${bulk(channel)}:${channels.get(channel).size}\r\n`,
      );
    }
    return true;
  }

  if (command === 'unsubscribe') {
    for (const subscribers of channels.values()) subscribers.delete(socket);
    socket.write('*3\r\n$11\r\nunsubscribe\r\n$-1\r\n:0\r\n');
    return true;
  }

  if (command === 'publish') {
    const [, channel, payload] = args;
    const subscribers = channels.get(channel) ?? new Set();
    for (const subscriber of subscribers) {
      subscriber.write(`*3\r\n$7\r\nmessage\r\n${bulk(channel)}${bulk(payload)}`);
    }
    socket.write(`:${subscribers.size}\r\n`);
    return true;
  }

  return false;
}

net
  .createServer((socket) => {
    // A client reset is a normal disconnect and must not stop the test server.
    socket.on('error', () => undefined);
    // Otherwise a reconnecting app leaves dead sockets receiving publishes.
    socket.on('close', () => {
      for (const subscribers of channels.values()) subscribers.delete(socket);
    });
    socket.on('data', (data) => {
      const args = parse(data);
      if (!args) {
        socket.write('-ERR malformed command\r\n');
        return;
      }
      if (handlePubSub(socket, args)) return;
      socket.write(execute(args));
    });
  })
  .listen(port, '127.0.0.1', () => {
    process.stdout.write(`test redis listening on ${port}\n`);
  });
