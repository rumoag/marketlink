import type { AppError } from '@/modules/kernel/domain/app-error';

/** Estado que devuelven las acciones de formulario: nunca refleja datos sensibles (BR-R5). */
export type FormState = {
  readonly message?: string;
  /** Confirmacion de una accion correcta (se anuncia a los lectores de pantalla). */
  readonly success?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /** Valores no sensibles para repoblar el formulario tras un error. */
  readonly values?: Readonly<Record<string, string>>;
};

export const emptyState: FormState = {};

/** Mensajes por campo, en lenguaje comprensible y sin detalles tecnicos (U1-NFR-US3). */
const FIELD_MESSAGES: Readonly<Record<string, string>> = {
  email: 'Escribe un correo electrónico válido.',
  artisticName: 'Escribe tu nombre artístico (entre 2 y 60 caracteres).',
  instagram: 'Usa solo letras, números, puntos y guiones bajos (hasta 30 caracteres).',
  phone: 'Escribe un teléfono español de 9 dígitos, por ejemplo 612 345 678.',
  bizumPhone: 'Escribe un móvil español de 9 dígitos, por ejemplo 612 345 678, o déjalo vacío.',
  acceptTerms: 'Para continuar debes aceptar el aviso de privacidad y las condiciones.',
  street: 'Escribe la calle (entre 2 y 120 caracteres).',
  number: 'Escribe el número (hasta 10 caracteres).',
  floorDoor: 'Máximo 20 caracteres.',
  postalCode:
    'Escribe un código postal de la península. De momento no enviamos desde islas, Ceuta ni Melilla.',
  city: 'Escribe la ciudad (entre 2 y 60 caracteres).',
  province: 'La provincia no corresponde al código postal.',
  title: 'El título debe tener entre 3 y 80 caracteres.',
  description: 'La descripción admite hasta 1.000 caracteres.',
  price: 'Escribe un precio entre 1 y 1.000 euros, por ejemplo 25 o 25,50.',
  declaredValue: 'El valor declarado debe estar entre 1 y 1.000 euros.',
  size: 'Elige un tamaño.',
  modality: 'Elige cómo se envía.',
  origins: 'Marca al menos una forma de enviar.',
  photos: 'Sube entre 1 y 3 fotos válidas (JPG, PNG o WebP).',
};

const GENERIC_BY_CODE: Readonly<Partial<Record<AppError['code'], string>>> = {
  rate_limited: 'Demasiados intentos. Prueba de nuevo dentro de un rato.',
  dependency_unavailable: 'El servicio no está disponible ahora. Prueba de nuevo en unos minutos.',
  conflict: 'Esta acción no se puede hacer ahora mismo.',
  not_found: 'No hemos encontrado lo que buscas.',
  unauthenticated: 'Tu sesión ha caducado. Vuelve a entrar.',
  forbidden: 'No tienes permiso para hacer esto.',
  internal: 'Ha ocurrido un error. Prueba de nuevo más tarde.',
};

/** Traduce un AppError al estado del formulario. Los valores recibidos no se reflejan. */
export const toFormState = (
  error: AppError,
  values: Readonly<Record<string, string>> = {},
): FormState => {
  if (error.code === 'validation' && error.details && error.details.length > 0) {
    const fieldErrors: Record<string, string> = {};
    for (const d of error.details) {
      fieldErrors[d.field] = FIELD_MESSAGES[d.field] ?? 'Revisa este campo.';
    }
    return { message: 'Revisa los campos marcados.', fieldErrors, values };
  }
  return { message: GENERIC_BY_CODE[error.code] ?? 'Ha ocurrido un error.', values };
};

/** Mensaje especifico para cuando faltan requisitos antes de crear enlaces o activar cobros. */
export const CONFLICT_MESSAGES = {
  payoutRequirements: 'Antes de activar los cobros completa tu perfil y tu dirección de envío.',
  payoutActive: 'Tus cobros ya están activos.',
  listingRequirements:
    'Para crear un enlace necesitas el perfil, la dirección y los cobros activos, y no superar el máximo de enlaces.',
} as const;

/** Valores de texto de un formulario, sin ficheros, para repoblar tras un error. */
export const textValues = (
  formData: FormData,
  names: readonly string[],
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = formData.get(name);
    if (typeof v === 'string') out[name] = v;
  }
  return out;
};
