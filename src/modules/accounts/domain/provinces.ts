/**
 * Provincias de la peninsula por prefijo de codigo postal (BR2-DR2, BR2-DR3). Excluye 07 (Baleares),
 * 35 y 38 (Canarias), 51 (Ceuta) y 52 (Melilla). Cada prefijo admite varios nombres (castellano y
 * lengua cooficial); la comparacion ignora mayusculas, acentos y espacios sobrantes.
 */
export const PROVINCES_BY_PREFIX: Readonly<Record<string, readonly string[]>> = {
  '01': ['Álava', 'Araba', 'Araba/Álava'],
  '02': ['Albacete'],
  '03': ['Alicante', 'Alacant', 'Alicante/Alacant'],
  '04': ['Almería'],
  '05': ['Ávila'],
  '06': ['Badajoz'],
  '08': ['Barcelona'],
  '09': ['Burgos'],
  '10': ['Cáceres'],
  '11': ['Cádiz'],
  '12': ['Castellón', 'Castelló', 'Castellón/Castelló'],
  '13': ['Ciudad Real'],
  '14': ['Córdoba'],
  '15': ['A Coruña', 'La Coruña', 'Coruña'],
  '16': ['Cuenca'],
  '17': ['Girona', 'Gerona'],
  '18': ['Granada'],
  '19': ['Guadalajara'],
  '20': ['Gipuzkoa', 'Guipúzcoa'],
  '21': ['Huelva'],
  '22': ['Huesca'],
  '23': ['Jaén'],
  '24': ['León'],
  '25': ['Lleida', 'Lérida'],
  '26': ['La Rioja', 'Rioja'],
  '27': ['Lugo'],
  '28': ['Madrid'],
  '29': ['Málaga'],
  '30': ['Murcia'],
  '31': ['Navarra', 'Nafarroa'],
  '32': ['Ourense', 'Orense'],
  '33': ['Asturias'],
  '34': ['Palencia'],
  '36': ['Pontevedra'],
  '37': ['Salamanca'],
  '39': ['Cantabria'],
  '40': ['Segovia'],
  '41': ['Sevilla'],
  '42': ['Soria'],
  '43': ['Tarragona'],
  '44': ['Teruel'],
  '45': ['Toledo'],
  '46': ['Valencia', 'València', 'Valencia/València'],
  '47': ['Valladolid'],
  '48': ['Bizkaia', 'Vizcaya'],
  '49': ['Zamora'],
  '50': ['Zaragoza'],
};

export const PENINSULAR_PREFIXES: readonly string[] = Object.keys(PROVINCES_BY_PREFIX);

/** Minusculas, sin acentos y con espacios compactados. */
export const normalizeProvinceName = (raw: string): string =>
  raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const NORMALIZED_BY_PREFIX: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(PROVINCES_BY_PREFIX).map(([prefix, names]) => [
    prefix,
    new Set(names.map(normalizeProvinceName)),
  ]),
);

/** BR2-DR3: la provincia declarada debe corresponder al prefijo del codigo postal. */
export const provinceMatchesPostalCode = (postalCode: string, province: string): boolean => {
  const names = NORMALIZED_BY_PREFIX[postalCode.slice(0, 2)];
  return names !== undefined && names.has(normalizeProvinceName(province));
};
