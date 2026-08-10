import net from 'node:net';

const port = Number(process.env.TEST_REDIS_PORT ?? 56379);
const values = new Map();
const expires = new Map();

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
    if (ex >= 0) expires.set(key, Date.now() + Number(args[ex + 1]) * 1000);
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
  if (command === 'geoadd') return ':1\r\n';
  if (command === 'zrem') return ':1\r\n';
  return '-ERR unsupported test command\r\n';
}

net
  .createServer((socket) => {
    // A client reset is a normal disconnect and must not stop the test server.
    socket.on('error', () => undefined);
    socket.on('data', (data) => {
      const args = parse(data);
      socket.write(args ? execute(args) : '-ERR malformed command\r\n');
    });
  })
  .listen(port, '127.0.0.1', () => {
    process.stdout.write(`test redis listening on ${port}\n`);
  });
