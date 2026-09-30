'use strict';
const crypto = require('node:crypto');

// Match the engine used by this project, including its historical hex format.
// https://github.com/prisma/prisma-engines/blob/5.22.0/schema-engine/connectors/schema-connector/src/checksum.rs
// Do not trim SQL, comments, a BOM, spaces or the final newline. A different SQL
// script must still fail. No stored migration checksum is rewritten here.
function migrationChecksumReport(bytes, storedChecksum) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Migration source must be a Buffer');
  const script = bytes.toString('utf8');
  if (!Buffer.from(script, 'utf8').equals(bytes)) {
    throw new Error('PHASE7_MIGRATION_INVALID_UTF8');
  }
  const scripts = [
    ['RAW', script],
    ['LF', script.replace(/\r\n/g, '\n')],
    // This is intentionally the exact 5.22.0 engine transformation, not a
    // whitespace normalizer or a newly invented migration equivalence rule.
    ['CRLF', script.replace(/\n/g, '\r\n')],
  ];
  const legacy = typeof storedChecksum === 'string' && storedChecksum.length > 0 && storedChecksum.length !== 64;
  const candidates = scripts.map(([format, text]) => {
    const digest = crypto.createHash('sha256').update(text, 'utf8').digest();
    const sha256 = digest.toString('hex');
    const checksum = legacy ? [...digest].map(byte => byte.toString(16)).join('') : sha256;
    return { format, sha256, checksum };
  });
  const match = candidates.find(candidate => candidate.checksum === storedChecksum);
  return {
    matches: !!match,
    matchMode: match ? match.format + (legacy ? '_LEGACY_HEX' : '') : null,
    storedChecksum: typeof storedChecksum === 'string' ? storedChecksum.slice(0, 128) : null,
    currentChecksum: candidates[0].sha256,
    candidates,
  };
}

module.exports = { migrationChecksumReport };
