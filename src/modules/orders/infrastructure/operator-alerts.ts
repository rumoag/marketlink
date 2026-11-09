import type { AuditLog } from '@/modules/platform/application/audit-log';
import type { OperatorNotifier } from '@/modules/platform/application/operator-notifier';
import type { AlertContext, OperatorAlertCode, OperatorAlerts } from '../application/ports';

const SEVERITY: Readonly<Record<OperatorAlertCode, 'warning' | 'critical'>> = {
  packlink_no_disponible: 'warning',
  doble_pago: 'warning',
  reembolso_fallido: 'critical',
  conciliacion_desajuste: 'critical',
  enlace_bloqueado_abuso: 'warning',
  packlink_borrador_fallido: 'critical',
  etiqueta_no_descargada: 'critical',
  incidencia_envio: 'critical',
  recogida_sin_elegir: 'warning',
  email_fallido: 'warning',
  borrador_sin_pagar: 'warning',
  liquidacion_bloqueada: 'warning',
  liquidacion_fallida: 'critical',
  liquidacion_sin_cargo: 'critical',
  retirada_fallida: 'critical',
  entrega_sin_confirmar: 'warning',
  disputa_abierta: 'critical',
  reembolso_externo: 'warning',
  acceso_operador_bloqueado: 'critical',
  seguridad_autenticacion: 'critical',
  seguridad_autorizacion: 'warning',
  seguridad_webhook: 'critical',
  auditoria_voluminosa: 'warning',
  limpieza_datos_fallida: 'warning',
};

/**
 * Aviso al operador en U3 (NFR-U3-31): evento de auditoria con codigo fijo + log de nivel alerta.
 * El contador de `/api/health/deep` se calcula contando estos eventos. El email llega en U4/U7
 * detras del mismo puerto. Sin datos personales: solo identificadores y codigos.
 */
export class AuditLogOperatorAlerts implements OperatorAlerts {
  constructor(
    private readonly audit: AuditLog,
    private readonly notifier: OperatorNotifier,
  ) {}

  async raise(
    code: OperatorAlertCode,
    context: AlertContext,
    correlationId: string,
  ): Promise<void> {
    await this.audit.record({
      actorType: 'system',
      action: 'operator_alert',
      resourceType: 'alert',
      resourceId: code,
      outcome: 'failure',
      correlationId,
      details: { code, ...context },
    });
    await this.notifier.notify({
      severity: SEVERITY[code],
      title: `Aviso: ${code}`,
      correlationId,
      details: { code, ...context },
    });
  }
}
