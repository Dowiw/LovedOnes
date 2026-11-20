import type { NextConfig } from 'next';
import rootPkg from '../../package.json';

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@loved-ones/shared'],
  env: {
    NEXT_PUBLIC_APP_VERSION: rootPkg.version ?? '0.1.0',
  },
};

export default nextConfig;
