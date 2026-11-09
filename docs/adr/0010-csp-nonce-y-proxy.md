# ADR 0010: CSP con nonce y `proxy.ts`

- Estado: aceptado
- Fecha: 2026-11-04
- Unidad: U1 Fundación

## Contexto

La política de seguridad de contenido no puede incluir `unsafe-inline` ni `unsafe-eval` (SECURITY-04). Next.js inyecta scripts y estilos propios que necesitan un nonce.

## Decisión

- Un nonce aleatorio de 128 bits por petición, generado en el proxy y puesto en `Content-Security-Policy` (en la petición, para que Next lo aplique al renderizar, y en la respuesta).
- `script-src 'self' 'nonce-…' 'strict-dynamic'`; `style-src 'self' 'nonce-…'`. En desarrollo se añade `'unsafe-eval'` a `script-src` (lo necesita React); nunca en producción.
- El archivo se llama `src/proxy.ts`: Next.js 16 sustituye `middleware.ts` por `proxy.ts`, que corre en Node.js. Eso permite usar `pg` para el límite de tasa y la auditoría sin runtime Edge.
- El diseño de la plataforma vive en `modules/platform/infrastructure/request-pipeline.ts`; `proxy.ts` solo delega.
- Toda respuesta del proxy (también los errores) lleva las cabeceras de seguridad y `Cache-Control: private, no-store`.
- Denegar por defecto: una ruta que no está en la tabla de rutas (`route-table.ts`) recibe 404 genérico.

## Consecuencias

- Las páginas se renderizan en cada petición (dinámicas): con el volumen del v0 cumple los 2 s. Las imágenes y los estáticos siguen cacheándose en el CDN.
- Cada unidad debe registrar sus rutas en `ROUTE_TABLE`; olvidarlo da un 404 visible en las pruebas, no un agujero.
- El E2E comprueba que el navegador no registra violaciones de CSP y que cada petición recibe un nonce distinto.
