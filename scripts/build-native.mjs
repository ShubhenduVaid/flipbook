import { buildNative } from "../src/env/native.mjs";

const force = process.argv.includes("--force");
try {
  const { built, path } = await buildNative({ force });
  console.log(built ? `built ${path}` : `up to date: ${path}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
