import type { NextConfig } from 'next';
const config: NextConfig = { output: 'standalone', transpilePackages: ['@doodle/shared'], poweredByHeader: false, async rewrites() { return [{ source: '/api/:path*', destination: `${process.env.GAME_SERVER_URL || 'http://127.0.0.1:4000'}/api/:path*` }]; } };
export default config;
