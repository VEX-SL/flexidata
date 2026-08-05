import { run } from "./harness.ts";

import "./classifier.test.ts";
import "./receipt-extraction.test.ts";
import "./validation.test.ts";
import "./export.test.ts";
import "./prompts.test.ts";
import "./agent-context.test.ts";
import "./recovery.test.ts";
import "./confidence-ux.test.ts";
import "./preprocess.test.ts";
import "./grounding-evidence.test.ts";
import "./entity-cleaner.test.ts";
import "./arabic-ocr.test.ts";
import "./arabic-corpus.test.ts";

await run();
