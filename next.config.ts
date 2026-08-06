import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingIncludes: {
    "/api/*": [
      "./data/universite.csv",
      "./data/yokatlas/manifest.json",
      "./data/yokatlas/program-index.json.gz",
      "./data/yokatlas/details/*.json.gz",
    ],
  },
};

export default nextConfig;
