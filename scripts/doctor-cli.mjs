import { runDoctor, formatDoctor, IS_MAC } from "../src/env/doctor.mjs";

const result = await runDoctor();
console.log(formatDoctor(result));
// Off macOS the most this machine can be is analysis-ready, so that is what passes.
process.exit((IS_MAC ? result.canRecord : result.canAnalyze) ? 0 : 1);
