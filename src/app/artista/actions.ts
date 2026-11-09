'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { emptyState, textValues, toFormState, type FormState } from '@/ui/form-state';
import { requestInfo, requireArtistId, requireServices } from '@/ui/server-context';

const PROFILE_FIELDS = ['artisticName', 'instagram', 'phone'] as const;
const ADDRESS_FIELDS = [
  'street',
  'number',
  'floorDoor',
  'postalCode',
  'city',
  'province',
  'phone',
] as const;
const LISTING_FIELDS = [
  'title',
  'description',
  'price',
  'declaredValue',
  'size',
  'modality',
] as const;

const str = (formData: FormData, name: string): string => String(formData.get(name) ?? '');

// ---------------------------------------------------------------------------------------------
// US-002, US-003: perfil y direccion
// ---------------------------------------------------------------------------------------------
export async function saveProfileAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const artistId = await requireArtistId();
  const { correlationId } = await requestInfo();
  const values = textValues(formData, PROFILE_FIELDS);

  const result = await requireServices().accounts.saveProfile(
    artistId,
    {
      artisticName: str(formData, 'artisticName'),
      instagram: str(formData, 'instagram'),
      phone: str(formData, 'phone'),
    },
    correlationId,
  );
  if (!result.ok) return toFormState(result.error, values);
  revalidatePath('/artista');
  return { success: 'Perfil guardado.', values };
}

export async function saveAddressAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const artistId = await requireArtistId();
  const { correlationId } = await requestInfo();
  const values = textValues(formData, ADDRESS_FIELDS);

  const result = await requireServices().accounts.saveSenderAddress(
    artistId,
    {
      street: str(formData, 'street'),
      number: str(formData, 'number'),
      floorDoor: str(formData, 'floorDoor'),
      postalCode: str(formData, 'postalCode'),
      city: str(formData, 'city'),
      province: str(formData, 'province'),
      phone: str(formData, 'phone'),
    },
    correlationId,
  );
  if (!result.ok) return toFormState(result.error, values);
  revalidatePath('/artista');
  return { success: 'Dirección guardada.', values };
}

// ---------------------------------------------------------------------------------------------
// US-004: activar cobros
// ---------------------------------------------------------------------------------------------
export async function startPayoutOnboardingAction(
  _prev: FormState,
  _formData: FormData,
): Promise<FormState> {
  const artistId = await requireArtistId();
  const { correlationId } = await requestInfo();
  const result = await requireServices().accounts.startPayoutOnboarding(artistId, correlationId);
  if (!result.ok) {
    if (result.error.code === 'conflict') {
      return {
        message:
          'Antes de activar los cobros completa tu perfil y tu dirección de envío, o comprueba que no estén ya activos.',
      };
    }
    return toFormState(result.error);
  }
  // Onboarding alojado por el proveedor (BR2-CB3).
  redirect(result.value.url);
  return emptyState;
}

// ---------------------------------------------------------------------------------------------
// US-006 a US-012: enlaces
// ---------------------------------------------------------------------------------------------
const listingRaw = (formData: FormData): Record<string, unknown> => {
  const declared = str(formData, 'declaredValue').trim();
  const raw: Record<string, unknown> = {
    title: str(formData, 'title'),
    description: str(formData, 'description'),
    fragile: formData.get('fragile') === 'on',
  };
  // Los campos deshabilitados (reserva activa) no se envian: no se tocan (BR2-ED3).
  for (const name of ['price', 'size', 'modality'] as const) {
    if (formData.has(name)) raw[name] = str(formData, name);
  }
  if (declared !== '') raw.declaredValue = declared;
  return raw;
};

const uploadIdsOf = (formData: FormData): unknown => {
  try {
    return JSON.parse(str(formData, 'uploadIds') || '[]') as unknown;
  } catch {
    return [];
  }
};

export async function createListingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const artistId = await requireArtistId();
  const { correlationId } = await requestInfo();
  if (formData.get('photosBusy') === '1') {
    return { message: 'Espera a que terminen de subirse las fotos.' };
  }
  const values = {
    ...textValues(formData, LISTING_FIELDS),
    fragile: String(formData.get('fragile') === 'on'),
  };

  const result = await requireServices().listings.createListing(
    artistId,
    listingRaw(formData),
    uploadIdsOf(formData),
    correlationId,
  );
  if (!result.ok) {
    if (result.error.code === 'conflict') {
      return {
        message:
          'Para crear un enlace necesitas el perfil, la dirección y los cobros activos, y no superar el máximo de enlaces.',
        values,
      };
    }
    return toFormState(result.error, values);
  }
  revalidatePath('/artista/enlaces');
  redirect(`/artista/enlaces/${result.value.id}?creado=1`);
  return emptyState;
}

export async function updateListingAction(
  listingId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const artistId = await requireArtistId();
  const values = textValues(formData, LISTING_FIELDS);
  const result = await requireServices().listings.updateListing(
    artistId,
    listingId,
    listingRaw(formData),
  );
  if (!result.ok) {
    if (result.error.code === 'conflict') {
      return {
        message: 'Este enlace no se puede cambiar ahora: hay un pago en curso o ya está vendido.',
        values,
      };
    }
    return toFormState(result.error, values);
  }
  revalidatePath(`/artista/enlaces/${listingId}`);
  return { success: 'Cambios guardados.', values };
}

export async function pauseListingAction(listingId: string): Promise<void> {
  const artistId = await requireArtistId();
  await requireServices().listings.pause(artistId, listingId);
  revalidatePath('/artista/enlaces');
  revalidatePath(`/artista/enlaces/${listingId}`);
}

export async function resumeListingAction(listingId: string): Promise<void> {
  const artistId = await requireArtistId();
  await requireServices().listings.resume(artistId, listingId);
  revalidatePath('/artista/enlaces');
  revalidatePath(`/artista/enlaces/${listingId}`);
}

export async function removePhotoAction(listingId: string, photoId: string): Promise<void> {
  const artistId = await requireArtistId();
  await requireServices().listings.removePhoto(artistId, listingId, photoId);
  revalidatePath(`/artista/enlaces/${listingId}`);
}

export async function addPhotosAction(
  listingId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const artistId = await requireArtistId();
  if (formData.get('photosBusy') === '1') {
    return { message: 'Espera a que terminen de subirse las fotos.' };
  }
  const ids = uploadIdsOf(formData);
  if (!Array.isArray(ids) || ids.length === 0) {
    return { message: 'Elige al menos una foto.' };
  }
  const services = requireServices();
  for (const id of ids) {
    const r = await services.listings.addPhoto(artistId, listingId, String(id));
    if (!r.ok) {
      return { message: 'No se han podido añadir todas las fotos. Un enlace admite hasta 3.' };
    }
  }
  revalidatePath(`/artista/enlaces/${listingId}`);
  return { success: 'Fotos añadidas.' };
}

// ---------------------------------------------------------------------------------------------
// U3: telefono de Bizum (opcional) y confirmacion de cobros manuales
// ---------------------------------------------------------------------------------------------
export async function saveBizumPhoneAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const artistId = await requireArtistId();
  const { correlationId } = await requestInfo();
  const values = textValues(formData, ['bizumPhone']);
  const result = await requireServices().contacts.save(
    artistId,
    str(formData, 'bizumPhone'),
    correlationId,
  );
  if (!result.ok) return toFormState(result.error, values);
  revalidatePath('/artista/perfil');
  return { success: 'Teléfono de Bizum guardado.', values };
}

export async function confirmManualPaymentAction(formData: FormData): Promise<void> {
  const artistId = await requireArtistId();
  const { correlationId } = await requestInfo();
  const orderId = str(formData, 'orderId');
  await requireServices().confirmManual.execute(artistId, orderId, correlationId);
  revalidatePath('/artista/pedidos');
  redirect('/artista/pedidos');
}

// ---------------------------------------------------------------------------------------------
// U4: elegir fecha y franja de recogida
// ---------------------------------------------------------------------------------------------
export async function chooseDraftPickupAction(orderId: string, formData: FormData): Promise<void> {
  const artistId = await requireArtistId();
  const optionId = str(formData, 'pickup');
  const result = await requireServices().chooseDraftPickup.execute(artistId, orderId, optionId);
  revalidatePath(`/artista/pedidos/${orderId}`);
  const outcome = !result.ok ? 'error' : result.value.kind === 'chosen' ? 'ok' : 'no';
  redirect(`/artista/pedidos/${orderId}?recogida=${outcome}`);
}
