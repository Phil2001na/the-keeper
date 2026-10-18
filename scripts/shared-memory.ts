import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { snapshot, submit, list, review } from '../src/sharedMemory/pilot.js';

const root = fileURLToPath(new URL('../docs/shared-memory/', import.meta.url));
const [command, ...args] = process.argv.slice(2);
try {
  let result: unknown;
  if (command === 'read' && !args.length) result = await snapshot(root);
  else if (command === 'list' && !args.length) result = await list(root);
  else if (command === 'submit' && args.length === 1) {
    result = await submit(root, JSON.parse(await readFile(args[0]!, 'utf8')));
  } else if (command === 'review' && args.length === 4) {
    result = await review(root, args[0]!, args[1]!, args[2]!, args[3]!);
  } else throw new Error('Usage: npm run memory -- read | list | submit <json-file> | review <id> <philip|keeper> <forward-to-keeper|reject> "note"');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Shared-memory operation failed');
  process.exitCode = 1;
}
