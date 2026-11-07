// Load the same shared scripts, in the same order, as the browser app shell.
const fs = require('node:fs');
const path = require('node:path');
module.exports = () =>
  ['ai-spending-ui.js', 'app.js']
    .map((name) => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8'))
    .join('\n');
