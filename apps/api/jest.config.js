/** Unit tests only — no DB/Redis required. See jest-e2e.config.js for integration tests. */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testRegex: "src/.*\\.spec\\.ts$",
  transform: { "^.+\\.ts$": ["ts-jest", { isolatedModules: true }] },
  moduleFileExtensions: ["ts", "js", "json"],
  collectCoverageFrom: ["src/**/*.ts"],
};
