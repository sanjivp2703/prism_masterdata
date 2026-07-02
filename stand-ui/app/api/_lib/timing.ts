import 'server-only';
import fs from 'fs';

// Phase-timing instrumentation. Lines go to the server console AND to a log file
// (default /tmp/prism-timing.log, override with PRISM_TIMING_LOG) so they can be
// read back without scraping the dev server's terminal. Temporary profiling aid.
const TIMING_LOG = process.env.PRISM_TIMING_LOG || '/tmp/prism-timing.log';

export function appendTiming(line: string): void {
  console.log(line);
  fs.promises.appendFile(TIMING_LOG, `${new Date().toISOString()} ${line}\n`).catch(() => {});
}
