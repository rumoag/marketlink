/**
 * Tabla de rutas con atributo de acceso explicito. Denegar por defecto (SECURITY-08):
 * una ruta que no esta registrada se trata como protegida y no se sirve.
 */
export type Access =
  | 'public' // cualquiera
  | 'artist' // sesion de artista
  | 'operator' // sesion de operador con segundo factor superado (U6)
  | 'internal'; // sin sesion: el propio manejador autentica con un secreto

export type RateLimitRuleName =
  | 'magic_link_email'
  | 'magic_link_ip'
  | 'quote_ip'
  | 'checkout_ip'
  | 'tracking_ip'
  | 'reserve_ip'
  | 'reserve_listing'
  | 'withdraw_artist'
  | 'operator_link_ip'
  | 'operator_panel'
  | 'operator_action'
  | 'listing_view'
  | 'photo_upload_artist'
  | 'listing_create_artist'
  | 'profile_save_artist'
  | 'payout_onboarding_artist';

export type RouteRule = {
  /** Ruta exacta, o prefijo si termina en `/*`. */
  readonly pattern: string;
  readonly access: Access;
  /** Regla de limitacion de tasa por IP, si aplica. */
  readonly rateLimit?: RateLimitRuleName;
  /** Falla cerrada si el almacen de contadores no esta disponible (autenticacion y pago). */
  readonly failClosed?: boolean;
};

export type RouteTable = readonly RouteRule[];

/** Rutas de U1. Cada unidad anade las suyas. */
export const ROUTE_TABLE: RouteTable = [
  { pattern: '/', access: 'public' },
  { pattern: '/api/health', access: 'public' },
  { pattern: '/api/health/deep', access: 'internal' },
  { pattern: '/api/internal/jobs/run', access: 'internal' },
  // U2: acceso del artista (el limite de tasa por IP y por email lo aplica SignInService).
  { pattern: '/acceso', access: 'public' },
  { pattern: '/acceso/enviado', access: 'public' },
  { pattern: '/acceso/confirmar', access: 'public' },
  // U2: area del artista (sesion obligatoria) y subida de fotos.
  { pattern: '/artista', access: 'artist' },
  { pattern: '/artista/*', access: 'artist' },
  { pattern: '/api/artista/fotos', access: 'artist' },
  // U6: panel del operador. El acceso es publico (las paginas del codigo comprueban su propia
  // sesion pendiente); todo lo demas exige sesion de operador con segundo factor superado.
  { pattern: '/operador/acceso', access: 'public' },
  { pattern: '/operador/acceso/confirmar', access: 'public' },
  { pattern: '/operador/acceso/codigo', access: 'public' },
  { pattern: '/operador', access: 'operator' },
  { pattern: '/operador/*', access: 'operator' },
  // U2: webhook de cuentas de Stripe Connect; se protege con la firma, no con sesion.
  { pattern: '/api/webhooks/stripe-connect', access: 'public' },
  // U2: ayudas de pruebas (solo con E2E_ENABLED y el secreto interno; 404 en caso contrario).
  { pattern: '/api/test/*', access: 'internal' },
  // U3: compra publica (sin cuenta). Los limites de tasa los aplican los servicios (fallo cerrado).
  { pattern: '/privacidad', access: 'public' },
  { pattern: '/condiciones', access: 'public' },
  { pattern: '/compra/exito', access: 'public' },
  { pattern: '/compra/cancelada', access: 'public' },
  { pattern: '/seguimiento/*', access: 'public' },
  // U3: webhook de la plataforma de Stripe; se protege con la firma, no con sesion.
  { pattern: '/api/webhooks/stripe', access: 'public' },
  // U4: webhook de Packlink; se protege con su secreto, no con sesion.
  { pattern: '/api/webhooks/packlink', access: 'public' },
  // U3: «pagina de Stripe» simulada; solo responde con E2E_ENABLED (404 en caso contrario).
  { pattern: '/e2e/*', access: 'public' },
];

/** Ruta publica de una obra: `/{slug}` con 8 caracteres del alfabeto del slug (U2). */
const SLUG_PATH = /^\/[a-hjkmnp-z2-9]{8}$/i;
export const SLUG_ROUTE: RouteRule = { pattern: '/:slug', access: 'public' };

/** El token de seguimiento viaja en la ruta: nunca debe llegar a logs ni a auditoria. */
export const maskPathForLogs = (pathname: string): string =>
  pathname.startsWith('/seguimiento/') ? '/seguimiento/[token]' : pathname;

/** Rutas del panel del operador (cabeceras propias: sin referente, nunca en cache). */
export const isOperatorPath = (pathname: string): boolean =>
  pathname === '/operador' || pathname.startsWith('/operador/');

const normalize = (pathname: string): string => {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return trimmed === '' ? '/' : trimmed;
};

/** Coincidencia exacta primero; despues el prefijo `/*` mas largo. Devuelve undefined si no hay. */
export const resolveRoute = (table: RouteTable, pathname: string): RouteRule | undefined => {
  const path = normalize(pathname);
  const exact = table.find((r) => !r.pattern.endsWith('/*') && r.pattern === path);
  if (exact) return exact;
  if (table === ROUTE_TABLE && SLUG_PATH.test(path)) return SLUG_ROUTE;
  let best: RouteRule | undefined;
  for (const rule of table) {
    if (!rule.pattern.endsWith('/*')) continue;
    const prefix = rule.pattern.slice(0, -2);
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      if (!best || rule.pattern.length > best.pattern.length) best = rule;
    }
  }
  return best;
};
