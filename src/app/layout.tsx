import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { getAppName } from '@/modules/platform/infrastructure/runtime';
import './globals.css';

// BR-E3: el nombre del producto sale solo de la configuracion.
const productName = (): string => getAppName();

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export function generateMetadata(): Metadata {
  return {
    title: productName(),
    description: 'Enlace de venta con envio para artistas independientes.',
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Leer las cabeceras hace dinamico el renderizado: necesario para el nonce de la CSP.
  await headers();
  return (
    <html lang="es">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
