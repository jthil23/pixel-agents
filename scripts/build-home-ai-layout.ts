import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildHomeAiLayout } from '../webview-ui/src/homeai/layoutBuilder.js';
import type { OfficeLayout } from '../webview-ui/src/office/types.js';

const assets = path.join(__dirname, '..', 'webview-ui', 'public', 'assets');
const defaultLayout = JSON.parse(
  fs.readFileSync(path.join(assets, 'default-layout-1.json'), 'utf8'),
) as OfficeLayout;
const out = path.join(assets, 'home-ai-layout.json');
fs.writeFileSync(out, `${JSON.stringify(buildHomeAiLayout(defaultLayout))}\n`);
console.log(`wrote ${out}`);
