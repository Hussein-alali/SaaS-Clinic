'use strict';
// Makes `node --test db/test/` work on every Node.js version (same as
// api/test/index.js):
//   - Node 18/20 (hosting.com) expand the directory and run each test file
//     in its own process; here this file is just another file and does
//     nothing (process.argv[1] is .../test/index.js).
//   - Node >= 21 treats `db/test/` as a glob that matches the directory
//     itself and executes it as a module, which resolves to this file with
//     process.argv[1] === this directory. Then every *.test.js is loaded
//     inside its own describe(), so each file's hooks stay scoped to that
//     file and the files run one after another in this process.

const fs = require('fs');
const path = require('path');

const runAsDirectory = !!process.argv[1] && path.resolve(process.argv[1]) === __dirname;

if (runAsDirectory) {
  const { describe } = require('node:test');
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .sort();
  for (const file of files) {
    describe(file, () => {
      require(path.join(__dirname, file));
    });
  }
}
