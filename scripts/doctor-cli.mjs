import { runDoctor, formatDoctor } from "../src/env/doctor.mjs";

const result = await runDoctor();
console.log(formatDoctor(result));
process.exit(result.ready ? 0 : 1);
