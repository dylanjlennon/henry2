import type { NextConfig } from "next";

const HENRY_API = process.env.HENRY_API_BASE_URL ?? 'https://henry-slack.vercel.app';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${HENRY_API}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
