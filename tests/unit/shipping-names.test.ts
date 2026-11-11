import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { splitFullName } from '@/modules/shipping/domain/names';

describe('splitFullName (Packlink exige nombre y apellido)', () => {
  it('separa por la primera palabra: el resto son los apellidos', () => {
    expect(splitFullName('Ana Art')).toEqual({ name: 'Ana', surname: 'Art' });
    expect(splitFullName('Rubén Moya Agustín')).toEqual({ name: 'Rubén', surname: 'Moya Agustín' });
    expect(splitFullName('  María   José  García ')).toEqual({
      name: 'María',
      surname: 'José García',
    });
  });

  it('un nombre de una sola palabra repite la palabra para no dejar el apellido vacio', () => {
    expect(splitFullName('prueba')).toEqual({ name: 'prueba', surname: 'prueba' });
  });

  it('nunca devuelve campos vacios, incluso con entradas raras (propiedad)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = splitFullName(s);
        expect(r.name.length).toBeGreaterThan(0);
        expect(r.surname.length).toBeGreaterThan(0);
        expect(r.name).not.toMatch(/\s/);
      }),
    );
  });

  it('con varias palabras, nombre y apellidos recomponen el original normalizado (propiedad)', () => {
    const word = fc.stringMatching(/^[A-Za-zÁÉÍÓÚáéíóúñÑ]{1,12}$/);
    fc.assert(
      fc.property(fc.array(word, { minLength: 2, maxLength: 5 }), (words) => {
        const r = splitFullName(` ${words.join('   ')} `);
        expect(`${r.name} ${r.surname}`).toBe(words.join(' '));
      }),
    );
  });
});
