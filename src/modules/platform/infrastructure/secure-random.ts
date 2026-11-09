import { randomBytes, randomUUID } from 'node:crypto';
import type { Random } from '@/modules/kernel/domain/clock';
import type { IdGenerator } from '../application/ports';

/** Fuente aleatoria criptografica en [0, 1) con 48 bits de resolucion. */
export const secureRandom: Random = {
  next: () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48,
};

export const uuidGenerator: IdGenerator = { uuid: () => randomUUID() };
