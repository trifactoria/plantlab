import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The support-bundle fixture screenshot run starts an isolated `next dev`
  // server inside the same repo directory as the live `next start`
  // deployment. Next dev and next start cannot share a .next directory - dev
  // rewrites it and removes required-server-files.json, which would break the
  // live server on its next restart. Setting PLANTLAB_NEXT_DIST_DIR gives the
  // fixture server its own build directory so it never touches the live
  // production .next. Unset everywhere else, so the default ".next" is used.
  ...(process.env.PLANTLAB_NEXT_DIST_DIR ? { distDir: process.env.PLANTLAB_NEXT_DIST_DIR } : {}),
};

export default nextConfig;
