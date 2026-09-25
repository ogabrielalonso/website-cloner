import type { NextConfig } from "next";

// Standalone output keeps a clone deployable as a self-contained server.
const config: NextConfig = { output: "standalone" };

export default config;
