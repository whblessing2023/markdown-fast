// Driver for the markdown-render-speed entry.
//
// The harness runs `node /bot/main.ts` (Node 22, types stripped natively).
// It reads every case from /input/cases.json — a JSON array of
// { id, markdown } — renders each one on its own with parse() from
// ./parse.js, and writes /output/html.json: a JSON array of the HTML
// strings, one per case, in the cases' order. Outside a container the
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR environment variables stand
// in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
  const html = cases.map((c) => parse(c.markdown));
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();
