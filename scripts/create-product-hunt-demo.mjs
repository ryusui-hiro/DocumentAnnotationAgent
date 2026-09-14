import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createProductHuntDemoWorkbook } from './product-hunt-demo-data.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'public/demos/customer-feedback-demo.xlsx');
await mkdir(resolve(root, 'public/demos'), { recursive: true });
await writeFile(output, await createProductHuntDemoWorkbook());
console.log(`Created ${output}`);
