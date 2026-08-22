export {};

const ARGS = [
  "bun",
  "build",
  "./src/cli.ts",
  "--compile",
  "--minify",
  "--target=bun-darwin-arm64",
  "--outfile",
  "./dist/hardline",
];

const proc = Bun.spawn(ARGS, { stdout: "inherit", stderr: "inherit" });
const code = await proc.exited;

if (code !== 0) {
  console.error("Échec de la construction du binaire.");
  process.exit(code);
}

console.log("Binaire produit : ./dist/hardline");
