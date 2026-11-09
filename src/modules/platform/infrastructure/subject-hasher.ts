import { createHmac } from 'node:crypto';
import type { SubjectHasher } from '../application/rate-limiter';

/** Resumen HMAC-SHA256 con sal secreta: la IP o el email nunca se guardan en claro (BR-L3). */
export const createSubjectHasher =
  (salt: string): SubjectHasher =>
  (rule, subject) =>
    createHmac('sha256', salt).update(`${rule}:${subject}`).digest('hex');
