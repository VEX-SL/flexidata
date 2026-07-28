// CommonJS wrapper for @napi-rs/canvas to avoid Turbopack ESM issues
// eslint-disable-next-line @typescript-eslint/no-require-imports
const canvas = require("@napi-rs/canvas");
export function createCanvas(width: number, height: number) {
  return canvas.createCanvas(width, height);
}
