import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@napi-rs/canvas"],
  outputFileTracingIncludes: {
    // OCR loads tesseract.js-core (emscripten wasm), wasm-feature-detect and
    // bmp-js at runtime through an opaque `eval("require")`, so Next's nft
    // tracing never follows that require graph. Without this block those
    // packages never reach the Lambda and OCR fails on the request thread.
    "/*": [
      "./node_modules/tesseract.js-core/package.json",
      "./node_modules/tesseract.js-core/index.js",
      "./node_modules/tesseract.js-core/tesseract-core.js",
      "./node_modules/tesseract.js-core/tesseract-core.wasm",
      "./node_modules/tesseract.js-core/tesseract-core-lstm.js",
      "./node_modules/tesseract.js-core/tesseract-core-lstm.wasm",
      "./node_modules/tesseract.js-core/tesseract-core-simd.js",
      "./node_modules/tesseract.js-core/tesseract-core-simd.wasm",
      "./node_modules/tesseract.js-core/tesseract-core-simd-lstm.js",
      "./node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm",
      "./node_modules/tesseract.js-core/tesseract-core-relaxedsimd.js",
      "./node_modules/tesseract.js-core/tesseract-core-relaxedsimd.wasm",
      "./node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.js",
      "./node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm",
      "./node_modules/wasm-feature-detect/**/*",
      "./node_modules/bmp-js/**/*",
    ],
  },
};

export default nextConfig;
