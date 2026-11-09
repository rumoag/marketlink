// Genera el secreto TOTP de un operador y muestra la URI para la aplicacion de autenticacion.
// No llama a ningun servicio: todo ocurre en tu equipo.
//
// Uso:
//   node scripts/ops/new-operator-totp.mjs tu@correo.com [NombreDelProducto]
//
// El secreto se imprime UNA vez. Guardalo solo en las variables de entorno de Vercel
// (OPERATOR_TOTP_SECRETS=tu@correo.com:SECRETO) y en tu aplicacion de autenticacion.
import { randomBytes } from 'node:crypto';

const email = (process.argv[2] ?? '').trim().toLowerCase();
const issuer = process.argv[3] ?? 'MarketLink';
if (!/^[^\s@:,]+@[^\s@:,]+\.[^\s@:,]+$/.test(email)) {
  process.stderr.write('Uso: node scripts/ops/new-operator-totp.mjs tu@correo.com [Producto]\n');
  process.exit(1);
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const base32 = (bytes) => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

const secret = base32(randomBytes(20));
const uri =
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}` +
  `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

process.stdout.write(`Operador: ${email}\n\n`);
process.stdout.write(
  `1) Añade esta cuenta a tu aplicación de autenticación con la URI:\n   ${uri}\n\n`,
);
process.stdout.write(`   (o escribe el secreto a mano: ${secret})\n\n`);
process.stdout.write(`2) En Vercel define:\n   OPERATOR_EMAILS=${email}\n`);
process.stdout.write(`   OPERATOR_TOTP_SECRETS=${email}:${secret}\n`);
process.stdout.write(`   OPERATOR_SESSION_SECRET=<32 caracteres o más aleatorios>\n\n`);
process.stdout.write(
  'Este secreto no se vuelve a mostrar. No lo compartas ni lo guardes en el repositorio.\n',
);
