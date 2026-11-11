import type { AccountsRepos } from '@/modules/accounts/application/ports';
import { err, ok } from '@/modules/kernel/domain/result';
import type { Clock } from '@/modules/kernel/domain/clock';
import type { ListingsRepos } from '@/modules/listings/application/ports';
import { markSold, type Listing } from '@/modules/listings/domain/listing';
import { consume, release, tryReserve } from '@/modules/listings/domain/reservation';
import { parseSlug } from '@/modules/listings/domain/slug';
import type { CheckoutListing, ListingSalesPort } from '@/modules/orders/application/ports';
import type { IdGenerator } from '@/modules/platform/application/ports';

type SalesRepos = ListingsRepos & AccountsRepos;

/**
 * Operaciones del enlace para la compra, dentro de la transaccion del llamador (el contrato de
 * U2, `ReservationService`, abre su propia transaccion y aqui hace falta atomicidad con el
 * pedido). Reutiliza el dominio de LST: reservar, consumir, liberar y vender.
 */
export const createListingSales = (
  repos: SalesRepos,
  clock: Clock,
  ids: IdGenerator,
): ListingSalesPort => {
  const toCheckout = async (listing: Listing): Promise<CheckoutListing | undefined> => {
    const now = clock.now();
    const [artist, address, sizes, active] = await Promise.all([
      repos.publicArtists.find(listing.artistId),
      repos.addresses.find(listing.artistId),
      repos.sizes.list(),
      repos.reservations.findActive(listing.id, now),
    ]);
    const size = sizes.find((s) => s.size === listing.size);
    if (!artist || !address || !size) return undefined;
    return {
      id: listing.id,
      artistId: listing.artistId,
      slug: listing.slug,
      status: listing.status,
      title: listing.title,
      description: listing.description,
      priceCents: listing.priceCents,
      declaredValueCents: listing.declaredValueCents,
      fragile: listing.fragile,
      size: listing.size,
      modality: listing.modality,
      origins: listing.origins,
      artisticName: artist.artisticName,
      instagram: artist.instagram,
      sender: {
        street: address.street,
        number: address.number,
        floorDoor: address.floorDoor,
        postalCode: address.postalCode,
        city: address.city,
        province: address.province,
        phone: address.phone,
      },
      parcel: {
        lengthCm: size.lengthCm,
        widthCm: size.widthCm,
        heightCm: size.heightCm,
        weightKg: size.weightKg,
      },
      reserved: active !== undefined,
    };
  };

  return {
    async findBySlug(rawSlug) {
      const slug = parseSlug(rawSlug);
      if (!slug.ok) return undefined;
      const listing = await repos.listings.findBySlug(slug.value);
      return listing ? toCheckout(listing) : undefined;
    },

    async findById(listingId) {
      const listing = await repos.listings.findById(listingId);
      return listing ? toCheckout(listing) : undefined;
    },

    async reserve(listingId, ttlMs) {
      const listing = await repos.listings.findByIdForUpdate(listingId);
      if (!listing) return err('not_found');
      const now = clock.now();
      await repos.reservations.expireDue(listingId, now);
      const active = await repos.reservations.findActive(listingId, now);
      const created = tryReserve(listing, active ? [active] : [], ttlMs, now, ids.uuid());
      if (!created.ok) {
        return err(created.error === 'already_reserved' ? 'already_reserved' : 'not_available');
      }
      await repos.reservations.insert(created.value, now);
      return ok({ reservationId: created.value.id });
    },

    async canSell(listingId, reservationId) {
      const listing = await repos.listings.findByIdForUpdate(listingId);
      if (!listing || listing.status === 'vendido') return false;
      const active = await repos.reservations.findActive(listingId, clock.now());
      const holdsIt = active !== undefined && active.id === reservationId;
      if (active !== undefined && !holdsIt) return false; // reservada por otro pedido
      // Activa: se puede vender. Pausada: solo si este pedido tiene la reserva (el pago ya se cobro).
      return listing.status === 'activo' || (listing.status === 'pausado' && holdsIt);
    },

    async sell(listingId, orderId, reservationId) {
      const listing = await repos.listings.findByIdForUpdate(listingId);
      if (!listing) return err('not_sellable');
      const now = clock.now();
      const active = await repos.reservations.findActive(listingId, now);
      const holdsIt = active !== undefined && active.id === reservationId;
      if (active !== undefined && !holdsIt) return err('not_sellable');
      const sold = markSold(listing, orderId, now, holdsIt);
      if (!sold.ok) return err('not_sellable');
      if (active) await repos.reservations.update(consume(active), now);
      await repos.listings.save(sold.value);
      return ok(undefined);
    },

    async release(reservationId) {
      const reservation = await repos.reservations.findById(reservationId);
      if (!reservation) return;
      const next = release(reservation);
      if (next !== reservation) await repos.reservations.update(next, clock.now());
    },
  };
};
