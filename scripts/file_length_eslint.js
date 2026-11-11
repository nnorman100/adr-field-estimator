'use strict';
// ESLint max-lines config for the 1,000-line single-file limit. A JavaScript file over the limit
// is an error, except the files listed in scripts/file_length_allowlist.json (already over the
// limit when the rule was adopted), which only warn. The required check for every file type, and
// the exact-count ceilings in file_length_baselines.json, is scripts/check-file-length.mts.
const fs = require('node:fs');
const path = require('node:path');

const allowlist = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'file_length_allowlist.json'), 'utf8'),
);

function fileLengthConfig({ limit = allowlist.limit, files = allowlist.files } = {}) {
  const allowed = files.filter((f) => /\.(js|mjs|cjs)$/.test(f));
  const rule = (level) => ({ 'max-lines': [level, { max: limit }] });
  const config = [{ files: ['**/*.{js,mjs,cjs}'], rules: rule('error') }];
  if (allowed.length) config.push({ files: allowed, rules: rule('warn') });
  return config;
}

module.exports = { fileLengthConfig };
