// Shared flat ESLint config. Consumers spread this array and append overrides:
//   const base = require('@regops/config/eslint-preset');
//   module.exports = [...base, { rules: { ... } }];
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const prettier = require("eslint-config-prettier");

module.exports = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: ["dist/**", ".next/**", "node_modules/**", "coverage/**", ".turbo/**"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
  // Plain CommonJS tooling config files (eslint.config.js, postcss.config.js, ...).
  {
    files: ["**/*.config.js", "**/*.config.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { require: "readonly", module: "writable", __dirname: "readonly", process: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];
