/**
 * Packlink PRO exige nombre y apellido por separado en el remitente y en el destinatario. Los
 * formularios recogen «nombre y apellidos» en un solo campo, asi que se separa por la primera
 * palabra (en espanol el nombre suele ir primero y los apellidos despues).
 *
 * Un nombre de una sola palabra (p. ej. un nombre artistico) no tiene apellido que separar: se
 * repite la palabra para no dejar el campo vacio, que Packlink rechaza.
 */
export type SplitName = { readonly name: string; readonly surname: string };

export const splitFullName = (full: string): SplitName => {
  const words = full
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const [first, ...rest] = words;
  if (first === undefined) return { name: '-', surname: '-' };
  return rest.length === 0
    ? { name: first, surname: first }
    : { name: first, surname: rest.join(' ') };
};
