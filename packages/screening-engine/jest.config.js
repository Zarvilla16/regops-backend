module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testRegex: "src/.*\\.spec\\.ts$",
  transform: { "^.+\\.ts$": ["ts-jest", { isolatedModules: true }] },
  moduleFileExtensions: ["ts", "js", "json"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.spec.ts", "!src/index.ts"],
  // functions is 80, not 90 like the rest — fallback.ts's real defaultSleep
  // (1s/4s real delays) and the two providers' unused-in-tests default
  // export paths are deliberately never exercised, to keep this suite fast
  // and network-free (see fallback.spec.ts's FAST_OPTIONS comment).
  coverageThreshold: {
    global: { statements: 90, branches: 85, functions: 80, lines: 90 },
  },
};
