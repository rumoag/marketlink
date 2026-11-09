import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { unwrap } from '@/modules/kernel/domain/result';
import { SharpImageProcessor } from '@/modules/listings/infrastructure/sharp-image-processor';
import {
  detectImageType,
  FULL_MAX_SIDE,
  targetDimensions,
  THUMB_MAX_SIDE,
  validateUpload,
} from '@/modules/listings/domain/photo-rules';

const processor = new SharpImageProcessor();

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } });

/** Foto de movil sintetica con metadatos EXIF, incluida una ubicacion GPS. */
const jpegWithGps = (width: number, height: number, orientation = 1) =>
  solid(width, height)
    .jpeg({ quality: 90 })
    .withExif({
      IFD0: { Copyright: 'Ana Art', Make: 'MovilFalso' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '40/1 25/1 0/1',
        GPSLongitudeRef: 'W',
        GPSLongitude: '3/1 42/1 0/1',
      },
    })
    .withMetadata({ orientation })
    .toBuffer();

const dims = async (bytes: Uint8Array) => {
  const meta = await sharp(Buffer.from(bytes)).metadata();
  return {
    width: meta.width,
    height: meta.height,
    format: meta.format,
    exif: meta.exif,
    icc: meta.icc,
  };
};

describe('SharpImageProcessor con imagenes reales (US-007, P2-FOT-2)', () => {
  it('reduce una foto grande a 1.600 y 480 px en WebP conservando la proporcion', async () => {
    const input = await jpegWithGps(4000, 3000);
    const out = unwrap(await processor.process(input));

    const full = await dims(out.full.bytes);
    const thumb = await dims(out.thumb.bytes);
    expect(full).toMatchObject({ width: 1600, height: 1200, format: 'webp' });
    expect(thumb).toMatchObject({ width: 480, height: 360, format: 'webp' });
    expect(out.full).toMatchObject({ width: 1600, height: 1200 });
    expect(out.thumb).toMatchObject({ width: 480, height: 360 });
    expect(out.full.bytes.byteLength).toBeLessThan(1024 * 1024); // cabe en el limite del bucket
  });

  it('coincide con el calculo puro de dimensiones (error <= 1 px) y no amplia', async () => {
    for (const [w, h] of [
      [4000, 3000],
      [3001, 1999],
      [1000, 4000],
      [800, 600],
      [300, 200],
    ] as const) {
      const out = unwrap(await processor.process(await solid(w, h).jpeg().toBuffer()));
      const expectedFull = targetDimensions(w, h, FULL_MAX_SIDE);
      const expectedThumb = targetDimensions(w, h, THUMB_MAX_SIDE);
      expect(Math.abs(out.full.width - expectedFull.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(out.full.height - expectedFull.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(out.thumb.width - expectedThumb.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(out.thumb.height - expectedThumb.height)).toBeLessThanOrEqual(1);
      expect(out.full.width).toBeLessThanOrEqual(w);
      expect(out.full.height).toBeLessThanOrEqual(h);
    }
  });

  it('elimina todos los metadatos, incluida la ubicacion GPS (U2-NFR-PR5)', async () => {
    const input = await jpegWithGps(1200, 800);
    // Precondicion: la entrada de verdad lleva EXIF con GPS.
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();
    expect(before.exif?.toString('latin1')).toContain('MovilFalso');

    const out = unwrap(await processor.process(input));
    for (const image of [out.full, out.thumb]) {
      const meta = await dims(image.bytes);
      expect(meta.exif).toBeUndefined();
      const raw = Buffer.from(image.bytes).toString('latin1');
      expect(raw).not.toContain('MovilFalso');
      expect(raw).not.toContain('Ana Art');
      expect(raw).not.toContain('GPS');
    }
  });

  it('aplica la orientacion EXIF antes de quitar los metadatos', async () => {
    // 400x200 marcada como girada 90 grados: debe quedar vertical, 200x400.
    const input = await jpegWithGps(400, 200, 6);
    const out = unwrap(await processor.process(input));
    expect(out.full).toMatchObject({ width: 200, height: 400 });
  });

  it('acepta PNG con transparencia y WebP', async () => {
    const png = await sharp({
      create: {
        width: 600,
        height: 400,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0.4 },
      },
    })
      .png()
      .toBuffer();
    const webp = await solid(500, 500).webp().toBuffer();
    for (const input of [png, webp]) {
      expect(detectImageType(input)).not.toBeNull();
      const out = unwrap(await processor.process(input));
      expect((await dims(out.full.bytes)).format).toBe('webp');
    }
  });

  it('rechaza ficheros corruptos o truncados sin lanzar', async () => {
    const good = await solid(800, 600).jpeg().toBuffer();
    const truncated = good.subarray(0, Math.floor(good.length / 3));
    const garbage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]);
    for (const bad of [truncated, garbage, Buffer.alloc(10)]) {
      const r = await processor.process(bad);
      expect(r.ok).toBe(false);
    }
  });

  it('rechaza una imagen animada (WebP con varios fotogramas)', async () => {
    const u32 = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n);
      return b;
    };
    const u24 = (n: number) => {
      const b = Buffer.alloc(3);
      b.writeUIntLE(n, 0, 3);
      return b;
    };
    const chunk = (tag: string, data: Buffer) =>
      Buffer.concat([
        Buffer.from(tag, 'latin1'),
        u32(data.length),
        data,
        data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
      ]);

    const w = 40;
    const h = 40;
    const still = await solid(w, h).webp({ lossless: true }).toBuffer();
    // Se extrae el chunk de imagen del WebP fijo y se envuelve en un contenedor animado.
    let offset = 12;
    let image: Buffer | undefined;
    while (offset < still.length) {
      const tag = still.toString('latin1', offset, offset + 4);
      const size = still.readUInt32LE(offset + 4);
      if (tag === 'VP8 ' || tag === 'VP8L') {
        image = still.subarray(offset, offset + 8 + size + (size % 2));
        break;
      }
      offset += 8 + size + (size % 2);
    }
    expect(image).toBeDefined();
    const frame = () =>
      chunk(
        'ANMF',
        Buffer.concat([
          u24(0),
          u24(0),
          u24(w - 1),
          u24(h - 1),
          u24(100),
          Buffer.from([0]),
          image as Buffer,
        ]),
      );
    const body = Buffer.concat([
      Buffer.from('WEBP', 'latin1'),
      chunk('VP8X', Buffer.concat([Buffer.from([0x02, 0, 0, 0]), u24(w - 1), u24(h - 1)])),
      chunk('ANIM', Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0])])),
      frame(),
      frame(),
    ]);
    const animated = Buffer.concat([Buffer.from('RIFF', 'latin1'), u32(body.length), body]);

    // Precondicion: la libreria ve de verdad dos fotogramas.
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(2);
    expect(validateUpload(animated).ok).toBe(true); // pasa la firma: la rechaza el procesado
    const r = await processor.process(animated);
    expect(!r.ok && r.error).toBe('unsupported_type');
  });

  it('una imagen que declara dimensiones enormes se rechaza rapido (bomba de descompresion)', async () => {
    // PNG con una cabecera IHDR de 40.000 x 40.000 px (1.600 megapixeles) y sin datos reales.
    const png = (() => {
      const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, crc]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(40_000, 0);
      ihdr.writeUInt32BE(40_000, 4);
      ihdr.set([8, 2, 0, 0, 0], 8);
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', Buffer.alloc(10)),
        chunk('IEND', Buffer.alloc(0)),
      ]);
    })();
    expect(validateUpload(png).ok).toBe(true); // pasa la firma y el tamano en bytes
    const started = Date.now();
    const r = await processor.process(png);
    expect(r.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it(
    'p95 de procesado por foto de 12 megapixeles por debajo de 3 s (U2-NFR-PF3)',
    { retry: 2 },
    async () => {
      const input = await solid(4000, 3000).jpeg({ quality: 85 }).toBuffer();
      const times: number[] = [];
      for (let i = 0; i < 12; i++) {
        const t0 = performance.now();
        unwrap(await processor.process(input));
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? 0;
      expect(p95).toBeLessThan(3000);
    },
  );
});
