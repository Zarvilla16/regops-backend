module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testRegex: "src/.*\\.spec\\.ts$",
  transform: { "^.+\\.ts$": ["ts-jest", { isolatedModules: true }] },
  moduleFileExtensions: ["ts", "js", "json"],
  collectCoverageFrom: ["src/factors/**/*.ts", "src/aggregate.ts"],
  coverageThreshold: {
    global: { statements: 95, branches: 95, functions: 95, lines: 95 },
  },
};
