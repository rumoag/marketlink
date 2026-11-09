import type { NextRequest } from 'next/server';
import { handleRequest } from '@/services/composition';

/**
 * Proxy de Next.js 16 (sustituye a middleware.ts y corre en Node.js). Toda la logica vive en
 * modules/platform: correlacion, CSP con nonce, cabeceras, denegar por defecto y limite de tasa.
 */
export async function proxy(request: NextRequest) {
  return handleRequest(request);
}

export const config = {
  // Se excluyen los recursos estaticos; todo lo demas pasa por la tabla de rutas.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
