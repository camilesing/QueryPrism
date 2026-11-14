// Test-only CJS stub for the ESM-only @mistralai/mistralai SDK (v2 has no
// CJS build and real top-level awaits, so neither jest's CJS runtime nor a
// ts-jest transform can load it). Wired via jest moduleNameMapper in both
// package.json (unit) and test/jest-e2e.json. @langchain/mistralai touches
// exactly one export here (the Mistral constructor) — production runtime is
// unaffected (Node >=22 require(esm) loads the real SDK).
class Mistral {
  constructor() {}
}
module.exports = { Mistral };
