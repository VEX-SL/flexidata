import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@napi-rs/canvas", "tesseract.js"],
  outputFileTracingIncludes: {
    // The tesseract.js OCR worker runs inside a worker_thread and resolves its
    // deps (tesseract.js-core, wasm-feature-detect, …) by plain `require`.
    // Next's nft tracing follows the worker entry file but not its require
    // graph, so without this those packages never reach the Lambda and the
    // worker fails silently (its `error` event is dropped), hanging uploads.
    "/*": [
      "./node_modules/tesseract.js/package.json",
      "./node_modules/tesseract.js/src/**/*",
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
      "./node_modules/idb-keyval/**/*",
      "./node_modules/is-url/**/*",
      "./node_modules/node-fetch/**/*",
      "./node_modules/regenerator-runtime/**/*",
      "./node_modules/zlibjs/**/*",
    ],
  },
};

export default nextConfig;
