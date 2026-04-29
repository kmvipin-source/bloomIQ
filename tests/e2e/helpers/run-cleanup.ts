/**
 * Standalone cleanup runner. Invoked by `npm run test:e2e:cleanup`.
 *
 * Kept separate from cleanup.ts so the latter can be safely imported by
 * global-setup / global-teardown without firing side effects.
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env.test") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env.local") });

import { cleanup } from "./cleanup";

cleanup()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
