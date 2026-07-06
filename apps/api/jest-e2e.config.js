/** Integration tests — require Postgres + Redis running (see docker-compose.yml) and migrations applied. */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testRegex: "test/.*\\.e2e-spec\\.ts$",
  transform: { "^.+\\.ts$": ["ts-jest", { isolatedModules: true }] },
  moduleFileExtensions: ["ts", "js", "json"],
  testTimeout: 30000,
};
