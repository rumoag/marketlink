import { appError } from '@/modules/kernel/domain/app-error';
import { err, ok, type Result } from '@/modules/kernel/domain/result';
import type { AppError } from '@/modules/kernel/domain/app-error';
import type { EmailMessage, EmailSender } from '../application/ports';

export type ResendOptions = {
  readonly apiKey: string;
  readonly from: string;
  /** Fuera de `live`: todos los correos van aqui con asunto `[PRUEBA]` (Q1 A de infraestructura). */
  readonly sandboxRedirect: string | undefined;
  /** `fetch` resiliente (10 s, circuito, reintento seguro con Idempotency-Key). */
  readonly fetch: typeof fetch;
  readonly baseUrl?: string;
};

/**
 * Correo por la API de Resend, en texto plano y sin imagenes. Los 4xx (salvo 429) son permanentes;
 * 429, 5xx, red y circuito abierto son reintentables.
 */
export class ResendEmailSender implements EmailSender {
  constructor(private readonly o: ResendOptions) {}

  async send(message: EmailMessage): Promise<Result<void, AppError>> {
    const redirected = this.o.sandboxRedirect !== undefined;
    const body = {
      from: this.o.from,
      to: [redirected ? this.o.sandboxRedirect : message.to],
      subject: redirected ? `[PRUEBA] ${message.subject}` : message.subject,
      text: message.text,
    };
    try {
      const res = await this.o.fetch(`${this.o.baseUrl ?? 'https://api.resend.com'}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.o.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return ok(undefined);
      if (res.status === 429) return err(appError('rate_limited'));
      if (res.status >= 500) return err(appError('dependency_unavailable'));
      return err(appError('validation')); // rechazo permanente: direccion o contenido invalidos
    } catch {
      return err(appError('dependency_unavailable'));
    }
  }
}
