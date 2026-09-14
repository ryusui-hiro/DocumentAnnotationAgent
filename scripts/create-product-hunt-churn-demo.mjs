import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createProductHuntChurnWorkbook } from './product-hunt-churn-demo-data.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'public/demos/customer-churn-risk-demo.xlsx');
await mkdir(resolve(root, 'public/demos'), { recursive: true });
await writeFile(output, await createProductHuntChurnWorkbook());
console.log(`Created ${output}`);
