import fs from 'node:fs';
import path from 'node:path';
const required=['src/server.mjs','src/db.mjs','src/security.mjs','src/integrations.mjs','public/app.js','public/styles.css','public/brand/risitigo-mark.svg','public/brand/risitigo-wordmark.svg','render.yaml','.env.example','package.json'];
const missing=required.filter(f=>!fs.existsSync(path.resolve(f)));
if(missing.length){console.error('FAIL missing:',missing);process.exit(1)}
for(const f of required){if(fs.statSync(path.resolve(f)).size===0){console.error('FAIL empty:',f);process.exit(1)}}
console.log(`PASS ${required.length} required project files`);
