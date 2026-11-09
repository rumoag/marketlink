import { MS } from '@/modules/kernel/domain/clock';
import { Email } from '@/modules/kernel/domain/formats';
import { unwrap } from '@/modules/kernel/domain/result';
import {
  ConfirmOperatorLink,
  RequestOperatorLink,
  SendOperatorLink,
  VerifyOperatorTotp,
  type OperatorDirectory,
} from '@/modules/operator/application/access';
import {
  AddNote,
  CloseFlag,
  GetMetrics,
  GetOperatorSummary,
  GetOrderDetail,
  GetSizeSettings,
  ListOrders,
  ListPendingDrafts,
  OpenFlag,
  OperatorRefund,
  OperatorRelease,
  RecordVisit,
  RetryDraft,
  SaveSizeSettings,
} from '@/modules/operator/application/panel';
import { OperatorSessions } from '@/modules/operator/infrastructure/operator-sessions';
import { stepOf, totpAtStep } from '@/modules/operator/domain/totp';
import type { RetrySettlements } from '@/modules/payouts/application/settlement';
import { buildU5, deliver, paidU5Order, type U5 } from './u5-harness';

export const OP_EMAIL = 'op@example.com';
export const OP_SECRET = 'JBSWY3DPEHPK3PXP';
export const SESSION_SECRET = 's'.repeat(40);

export type QueuedJob = { type: string; payload: Record<string, unknown>; dedupeKey: string };

export const buildU6 = (options: Parameters<typeof buildU5>[0] = {}) => {
  const u5 = buildU5(options);
  const { db, clock, ids, audit, alerts, logger, limiter } = u5;
  const jobs: QueuedJob[] = [];
  const enqueue = (input: QueuedJob): Promise<unknown> => {
    jobs.push(input);
    return Promise.resolve();
  };
  const directory: OperatorDirectory = {
    isAuthorized: (e) => e.trim().toLowerCase() === OP_EMAIL,
    totpSecret: (e) => (e.trim().toLowerCase() === OP_EMAIL ? OP_SECRET : undefined),
    all: () => [OP_EMAIL],
  };
  const access = {
    auth: u5.auth,
    directory,
    runner: db,
    limiter,
    audit,
    alerts,
    enqueue,
    clock,
    logger,
  };
  const verifyTotp = new VerifyOperatorTotp(access);
  const panel = {
    runner: db,
    directory,
    limiter,
    audit,
    clock,
    ids,
    logger,
    staleDays: 10,
    totp: verifyTotp,
    draft: u5.draft,
    release: u5.release,
    refund: u5.refundOrder,
  };
  const actor = { email: OP_EMAIL };

  /** Código TOTP válido ahora; cada llamada usa un paso posterior (los pasos no se reutilizan). */
  const nextCode = (): string => {
    clock.advance(MS.minute); // salta a un paso nuevo (30 s) sin salir de la ventana
    return totpAtStep(OP_SECRET, stepOf(clock.now())) as string;
  };

  return {
    ...u5,
    jobs,
    directory,
    actor,
    nextCode,
    verifyTotp,
    requestLink: new RequestOperatorLink(access),
    sendLink: new SendOperatorLink(access),
    confirmLink: new ConfirmOperatorLink(access),
    listOrders: new ListOrders(panel),
    orderDetail: new GetOrderDetail(panel),
    drafts: new ListPendingDrafts(panel),
    summary: new GetOperatorSummary(panel),
    retryDraft: new RetryDraft(panel),
    openFlag: new OpenFlag(panel),
    closeFlag: new CloseFlag(panel),
    addNote: new AddNote(panel),
    opRelease: new OperatorRelease(panel),
    opRefund: new OperatorRefund(panel),
    sizes: new GetSizeSettings(panel),
    saveSizes: new SaveSizeSettings(panel),
    metrics: new GetMetrics(panel),
    recordVisit: new RecordVisit({ runner: db, limiter, clock, logger }),
    sessions: new OperatorSessions({
      secret: SESSION_SECRET,
      directory,
      clock,
      secure: true,
    }),
    retrySettlements: u5.retry as RetrySettlements,
    /** Enlace de acceso válido del operador (el proveedor lo emite al pedir el enlace). */
    issueLink: (email: string = OP_EMAIL): string => u5.auth.issue(unwrap(Email.parse(email))),
  };
};
export type U6 = ReturnType<typeof buildU6>;
export { deliver, paidU5Order };
export type { U5 };
