import { run } from "./harness.ts";

import "./classifier.test.ts";
import "./receipt-extraction.test.ts";
import "./validation.test.ts";
import "./export.test.ts";
import "./prompts.test.ts";

await run();
