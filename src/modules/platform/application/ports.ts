/** Puertos de la plataforma. La aplicacion depende de ellos; infraestructura los implementa. */

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Devuelve un logger que anade siempre estos campos (p. ej. correlationId). */
  child(bindings: LogFields): Logger;
}

export type Role = 'artist' | 'operator';

export type Session = {
  readonly userId: string;
  readonly role: Role;
  /** Instante (ms) en que la persona entro con enlace magico: base de la «sesion reciente» (U5). */
  readonly loginAt?: number;
  /** Cabeceras Set-Cookie que la respuesta debe incluir (renovacion de tokens o de actividad). */
  readonly setCookies?: readonly string[];
};

/** Resuelve la sesion de una peticion. La implementacion real llega con ACC (U2). */
export interface SessionResolver {
  resolve(headers: Headers): Promise<Session | null>;
}

/** En U1 no hay autenticacion: ninguna peticion tiene sesion. */
export const noSessionResolver: SessionResolver = { resolve: () => Promise.resolve(null) };

/** Generador de identificadores unicos (inyectable para pruebas). */
export interface IdGenerator {
  uuid(): string;
}
