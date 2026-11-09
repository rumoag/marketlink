# ADR 0012: Dependencias nuevas de U2

- Estado: aceptado
- Fecha: 2026-11-05
- Unidad: U2 Artistas y enlaces

## Decisión

Se añaden, con versión exacta y lockfile:

| Paquete                 | Versión             | Uso                                                                                                      | Justificación                                     |
| ----------------------- | ------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `@supabase/supabase-js` | 2.119.0             | Autenticación (enlace de acceso, verificación del token), Storage y API de administración (solo pruebas) | Supabase es el proveedor decidido en Requirements |
| `stripe`                | 23.1.0              | Cuentas conectadas Express, enlace de onboarding, estado de cuenta, verificación de firma del webhook    | Stripe Connect es el proveedor decidido           |
| `sharp`                 | 0.35.5 (Apache-2.0) | Validar, quitar metadatos, reducir y convertir a WebP en el servidor                                     | Estándar de Next.js; binarios precompilados       |

## Dependencia descartada: `@supabase/ssr`

Se instaló primero y se desinstaló antes de usarla: las cookies de sesión (`ml_at`, `ml_rt`, `ml_act`) las gestiona la propia aplicación, con atributos explícitos `HttpOnly`, `Secure` y `SameSite=Lax`, una cookie de actividad firmada (vigencia de 7 y 30 días) y renovación del token en el proxy. Evita una capa que no encaja con esa política de sesión y una dependencia sin uso (SECURITY-10).

## Verificación al instalar (2026-11-05)

- `sharp` carga y genera WebP en Windows (binario precompilado) sin script de instalación que aprobar; el build de CI en Linux lo vuelve a comprobar.
- `npm audit --omit=dev`: 0 avisos. Los avisos moderados restantes están en herramientas de desarrollo (ver ADR 0008).
- `tsc`, ESLint y las pruebas existentes siguen en verde con las dependencias nuevas.

## Reglas de uso

- Los SDK y `sharp` solo se importan en `infrastructure` (regla de ESLint de límites de capas).
- Las llamadas de red de Supabase y Stripe pasan por el cliente HTTP resiliente de U1 inyectado como `fetch` o cliente HTTP. Si un SDK no lo admitiera, se usa su configuración nativa con tiempo de espera y se anota aquí.
- `sharp` solo procesa imágenes que han superado la comprobación de firma y de tamaño, con límite de píxeles de entrada.
