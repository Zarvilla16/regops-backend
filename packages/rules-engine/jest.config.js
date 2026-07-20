module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testRegex: "src/.*\\.spec\\.ts$",
  transform: { "^.+\\.ts$": ["ts-jest", { isolatedModules: true }] },
  moduleFileExtensions: ["ts", "js", "json"],
  collectCoverageFrom: ["src/evaluators/**/*.ts", "src/dedup.ts", "src/dispatch.ts"],
  coverageThreshold: {
    global: { statements: 90, branches: 80, functions: 90, lines: 90 },
  },
};
