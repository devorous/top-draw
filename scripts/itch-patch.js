import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, '../dist');

writeFileSync(`${dist}/index.html`, `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="refresh" content="0; url=./go/index.html">
  <script>window.location.replace('./go/index.html');</script>
</head>
<body></body>
</html>`);
console.log('itch: patched dist/index.html → go/index.html redirect');
