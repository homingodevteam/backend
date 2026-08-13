import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [, , collectionPath, evidencePath] = process.argv;
if (!collectionPath || !evidencePath) {
  throw new Error(
    'Usage: node attach-geo-postman-examples.mjs <collection.json> <responses.json>',
  );
}

const collectionFile = resolve(collectionPath);
const evidenceFile = resolve(evidencePath);
const collection = JSON.parse(await readFile(collectionFile, 'utf8'));
const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'));

const executionByName = new Map();
for (const execution of evidence.executions) {
  // pm.sendRequest fan-out carries the parent item name on its child calls.
  // The first execution is the collection request itself and is the example
  // Postman should display.
  if (!executionByName.has(execution.name)) {
    executionByName.set(execution.name, execution);
  }
}

let attached = 0;
function visit(items) {
  for (const item of items) {
    if (item.item) visit(item.item);
    if (!item.request) continue;

    const execution = executionByName.get(item.name);
    if (!execution) {
      throw new Error(`No verified response evidence for ${item.name}`);
    }

    item.response = [
      {
        name: `${execution.response.code} ${execution.response.status} — verified isolated fixture`,
        originalRequest: item.request,
        status: execution.response.status,
        code: execution.response.code,
        _postman_previewlanguage: 'json',
        header: execution.response.headers,
        cookie: [],
        body:
          typeof execution.response.body === 'string'
            ? execution.response.body
            : JSON.stringify(execution.response.body, null, 2),
      },
    ];
    attached += 1;
  }
}

visit(collection.item);
await writeFile(collectionFile, `${JSON.stringify(collection, null, 2)}\n`);
console.log(`Attached ${attached} sanitized saved examples to ${collectionFile}`);
