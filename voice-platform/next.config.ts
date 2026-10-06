import type { NextConfig } from "next";

const deploymentVersion = process.env.DEPLOYMENT_VERSION?.trim();

const nextConfig: NextConfig = {
  basePath: "/voice-platform",
  output: "standalone",
  // voice-platform ships with its own lockfile and is built as an isolated
  // service. Prevent Next.js from tracing the parent application's workspace.
  outputFileTracingRoot: process.cwd(),
  deploymentId: deploymentVersion || undefined,
  generateBuildId: deploymentVersion ? async () => deploymentVersion : undefined,
  allowedDevOrigins: [
    '0fb80e6a-09a8-42a8-b7bb-aadbfdeef5e5.dev.coze.site',
    '0fb80e6a-09a8-42a8-b7bb-aadbfdeef5e5-5000.dev.coze.site',
    '0fb80e6a-09a8-42a8-b7bb-aadbfdeef5e5-5001.dev.coze.site',
  ],
  redirects: async () => [
    {
      source: '/',
      destination: '/voice-platform',
      basePath: false,
      permanent: false,
    },
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
