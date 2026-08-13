import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [, , inputPath, outputPath, summaryPath] = process.argv;
if (!inputPath || !outputPath || !summaryPath) {
  throw new Error(
    'Usage: node export-geo-postman-evidence.mjs <newman.json> <responses.json> <summary.md>',
  );
}

const source = JSON.parse(await readFile(resolve(inputPath), 'utf8'));

function decodedBody(stream) {
  if (typeof stream === 'string') return stream;
  if (stream?.type === 'Buffer' && Array.isArray(stream.data)) {
    return Buffer.from(stream.data).toString('utf8');
  }
  return '';
}

function readableBody(stream) {
  const text = decodedBody(stream);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function redactSecrets(value) {
  const secretKeys = new Set([
    'accessToken',
    'refreshToken',
    'providerRef',
  ]);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      secretKeys.has(key) ||
      (key === 'code' && /^\d{4,8}$/.test(String(child)))
        ? '[REDACTED]'
        : redactSecrets(child),
    ]),
  );
}

function safeHeaders(headers = []) {
  const secretHeaders = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'proxy-authorization',
  ]);
  return headers
    .filter((header) => !secretHeaders.has(String(header.key).toLowerCase()))
    .map(({ key, value }) => ({ key, value }));
}

const executions = (source.run?.executions ?? []).map((execution, index) => {
  const requestBody = execution.request?.body?.raw;
  let parsedRequestBody = requestBody ?? null;
  if (requestBody) {
    try {
      parsedRequestBody = JSON.parse(requestBody);
    } catch {
      // Preserve non-JSON request bodies exactly as sent.
    }
  }

  return {
    sequence: index + 1,
    name: execution.item?.name ?? `Request ${index + 1}`,
    request: {
      method: execution.request?.method ?? null,
      url: execution.request?.url?.raw ?? null,
      headers: safeHeaders(execution.request?.header),
      hasBody: requestBody !== undefined,
      ...(requestBody !== undefined
        ? { body: redactSecrets(parsedRequestBody) }
        : {}),
    },
    response: {
      status: execution.response?.status ?? null,
      code: execution.response?.code ?? null,
      responseTimeMs: execution.response?.responseTime ?? null,
      responseSizeBytes: execution.response?.responseSize ?? null,
      headers: safeHeaders(execution.response?.header),
      body: redactSecrets(readableBody(execution.response?.stream)),
    },
    assertions: (execution.assertions ?? []).map((assertion) => ({
      name: assertion.assertion,
      passed: !assertion.error,
      error: assertion.error?.message ?? null,
    })),
  };
});

const stats = source.run?.stats ?? {};
const evidence = {
  generatedAt: new Date().toISOString(),
  description:
    'Sanitized Newman evidence from real HTTP calls to an isolated Homingo application stack. Authorization and cookie headers are intentionally omitted.',
  summary: {
    requests: executions.length,
    // Newman is authoritative here. pm.sendRequest fan-out executions carry
    // the parent item's assertion list on every child response, so summing the
    // execution arrays would count those assertions more than once.
    assertions: stats.assertions?.total ?? null,
    failedAssertions: stats.assertions?.failed ?? null,
    requestStats: stats.requests ?? null,
    assertionStats: stats.assertions ?? null,
  },
  executions,
};

const summaryRows = executions.map((execution) => {
  const failed = execution.assertions.filter((assertion) => !assertion.passed).length;
  const assertionResult = failed === 0 ? 'Pass' : `Fail (${failed})`;
  return `| ${execution.sequence} | ${execution.request.method} | ${execution.name.replaceAll('|', '\\|')} | ${execution.response.code} | ${execution.response.responseTimeMs ?? ''} | ${assertionResult} |`;
});

const markdown = `# Homingo Geo API response evidence

Generated: ${evidence.generatedAt}

This report lists the real HTTP responses captured by Newman against the isolated Homingo application stack. Authorization and cookie headers are removed. Full request and response bodies are in \`Homingo-Geo-Indore.responses.json\`.

- Requests: ${evidence.summary.requests}
- Assertions: ${evidence.summary.assertions}
- Failed assertions: ${evidence.summary.failedAssertions}

| # | Method | Request | Status | Time (ms) | Tests |
|---:|:---:|---|---:|---:|---:|
${summaryRows.join('\n')}
`;

await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(resolve(outputPath), `${JSON.stringify(evidence, null, 2)}\n`);
await writeFile(resolve(summaryPath), markdown);

console.log(
  `Exported ${evidence.summary.requests} sanitized responses to ${resolve(outputPath)}`,
);
