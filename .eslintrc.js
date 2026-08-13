module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: ["tsconfig.json", "tsconfig.dev.json"],
    sourceType: "module",
  },
  ignorePatterns: [
    "/lib/**/*",       // Ignore built files
    "/generated/**/*", // Ignore generated files
    ".eslintrc.js",    // Ignore self
  ],
  plugins: [
    "@typescript-eslint",
  ],
  rules: {
    // Relax style rules for our codebase
    "quotes": ["warn", "double", { avoidEscape: true }],
    "indent": "off",
    "max-len": "off",
    "@typescript-eslint/no-unused-vars": ["warn", {
      "argsIgnorePattern": "^_",
      "varsIgnorePattern": "^_",
    }],
    "@typescript-eslint/no-explicit-any": "warn",
  },
};
