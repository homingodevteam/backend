import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [, , collectionPath, outputDirectory] = process.argv;
if (!collectionPath || !outputDirectory) {
  throw new Error(
    'Usage: node prepare-postman-mcp-example-batches.mjs <collection.json> <output-directory>',
  );
}

const collection = JSON.parse(await readFile(resolve(collectionPath), 'utf8'));
const examples = [];

function visit(items) {
  for (const item of items) {
    if (item.item) visit(item.item);
    if (!item.request) continue;
    const response = item.response?.[0];
    if (!response) throw new Error(`Missing saved example for ${item.name}`);

    examples.push({
      requestName: item.name,
      args: {
        name: response.name,
        method: item.request.method,
        url: item.request.url?.raw ?? null,
        status: response.status,
        responseCode: { code: response.code, name: response.status },
        language: 'json',
        mime: 'application/json',
        rawDataType: 'json',
        text: response.body,
        headers: response.header,
        requestObject: JSON.stringify(item.request),
        ...(item.request.body?.raw
          ? {
              dataMode: 'raw',
              rawModeData: item.request.body.raw,
              dataOptions: { raw: { language: 'json' } },
            }
          : {}),
      },
    });
  }
}

visit(collection.item);
const output = resolve(outputDirectory);
await mkdir(output, { recursive: true });

// Keep every MCP payload comfortably below the connector/proxy limit.
const batches = [];
let current = [];
for (const example of examples) {
  const candidate = [...current, example];
  if (current.length && JSON.stringify(candidate).length > 14_000) {
    batches.push(current);
    current = [example];
  } else {
    current = candidate;
  }
}
if (current.length) batches.push(current);

for (let index = 0; index < batches.length; index += 1) {
  await writeFile(
    resolve(output, `batch-${String(index + 1).padStart(2, '0')}.json`),
    JSON.stringify(batches[index]),
  );
}
await writeFile(
  resolve(output, 'manifest.json'),
  JSON.stringify({ batchCount: batches.length, exampleCount: examples.length }),
);
console.log(`Prepared ${examples.length} examples in ${batches.length} MCP batches.`);
