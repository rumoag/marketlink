/**
 * Cuotas a vigilar y fecha de la ultima revision (BR7-SL1, Q2 A). La aplicacion no puede medir el
 * consumo real de los proveedores: esto es un recordatorio mensual. Al revisar los paneles de los
 * proveedores, actualiza la fecha (y `docs/quotas.md`); pasados 35 dias la pantalla de salud avisa.
 */
export const QUOTAS_REVIEWED_AT = '2026-11-08';

export const QUOTA_ITEMS: readonly { readonly service: string; readonly watch: string }[] = [
  { service: 'Stripe', watch: 'Peticiones por segundo, endpoints de webhook y comisiones reales' },
  { service: 'Packlink PRO', watch: 'Límite de peticiones y registro de integración' },
  { service: 'Resend', watch: 'Envíos al día y al mes del plan; dominio verificado' },
  {
    service: 'Supabase',
    watch: 'Base de datos (tamaño), Storage (fotos) y correos de Auth por hora',
  },
  { service: 'Vercel', watch: 'Invocaciones, duración, ancho de banda y tamaño del despliegue' },
  { service: 'GitHub Actions', watch: 'Minutos al mes y almacenamiento de artefactos (copias)' },
  { service: 'UptimeRobot', watch: 'Monitores y frecuencia del plan gratuito' },
];

/** Instante (ms UTC) de la última revisión. */
export const quotasReviewedAtMs = (): number => Date.parse(`${QUOTAS_REVIEWED_AT}T00:00:00Z`);
