import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Las cabeceras de seguridad y la CSP con nonce las aplica middleware.ts.
  images: {
    // Las imagenes llegan por URLs firmadas de Supabase Storage (se ajusta en U2).
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co', pathname: '/storage/v1/object/sign/**' },
    ],
  },
};

export default config;
