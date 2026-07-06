const base = require("@regops/config/eslint-preset");

module.exports = [
  ...base,
  {
    rules: {
      // NestJS DI guards/strategies are often empty subclasses (e.g. `class JwtAuthGuard extends AuthGuard('jwt') {}`).
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
];
