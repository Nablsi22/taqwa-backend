const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.scripts.dev = 'tsc-watch -p tsconfig.build.json --onSuccess "node dist/main.js"';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));
console.log('Added dev script');
