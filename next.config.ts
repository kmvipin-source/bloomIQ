import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // React Compiler is experimental — it adds compile time and has caused
  // weird pauses + chunk-load errors in dev mode. Off by default; flip
  // back on once the project is stable and you want the perf bump.
  reactCompiler: false,
  // Hide the small dev-mode "Rendering"/"Building" badge.
  devIndicators: false,
};

export default nextConfig;
