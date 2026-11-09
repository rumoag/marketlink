# ADR 0013: Subida de fotos y alta atómica del enlace

- Estado: aceptado
- Fecha: 2026-11-05
- Unidad: U2 Artistas y enlaces

## Contexto

Las funciones de Vercel admiten cuerpos de unos 4,5 MB y una foto de móvil pesa entre 3 y 8 MB. Un enlace lleva de 1 a 3 fotos y debe crearse de forma atómica: o todo o nada, sin objetos huérfanos. Las fotos suelen llevar ubicación GPS en los metadatos.

## Decisión

1. **Una foto por petición.** El navegador la reduce (lado largo de 1.600 px, JPEG) antes de subirla y envía los bytes como cuerpo crudo a `/api/artista/fotos`. El servidor admite como máximo 4 MB y **siempre revalida y reprocesa**: no confía en el navegador.
2. **Validación por contenido.** Se decide el tipo por la firma de los primeros bytes (JPEG, PNG o WebP), no por la extensión ni por el tipo declarado.
3. **Procesado con `sharp`** (límite de 40 megapíxeles de entrada, rechazo de imágenes animadas): se aplica la orientación EXIF, se **eliminan todos los metadatos** (incluida la ubicación) y se generan dos tamaños en WebP (1.600 y 480 px) con una sola decodificación. Las dos claves de objeto son UUID; el nombre original se descarta.
4. **Subidas pendientes** (`photo_uploads`, caducan a las 24 h). Cada foto procesada y guardada queda registrada ahí. Al crear el enlace, una sola transacción comprueba que las subidas son del artista, están pendientes y vigentes, inserta el enlace y sus fotos y las marca como consumidas. Si algo falla, todo se deshace y las subidas siguen pendientes: el artista reintenta sin resubir.
5. **Limpieza diaria** (`cleanup_orphan_uploads`): borra las pendientes caducadas y sus objetos; si Storage falla, conserva las filas y reintenta (nada queda huérfano sin registro).
6. **Servir**: URL firmada de 1 h directamente de Storage, sin pasar por el optimizador de imágenes de Vercel (evita su cuota; cada URL firmada nueva contaría como imagen nueva).

## Alternativas descartadas

- Subir el original directamente a Storage con URL firmada y procesarlo después: un viaje más, objetos temporales y limpieza adicional.
- Estado `borrador` del enlace: añade un estado a la máquina del enlace y enlaces a medias que listar y limpiar.

## Consecuencias

- Crear un enlace con 3 fotos cabe en 10 s en 4G; el procesado de servidor medido con fotos de 12 megapíxeles está muy por debajo de 3 s.
- Un fallo a mitad del alta deja como mucho subidas pendientes que caducan solas.
- La reducción en el navegador es una ayuda de ancho de banda y de privacidad (el canvas descarta metadatos), nunca una garantía.
- Las fotos no se copian en el v0 (riesgo aceptado, a revisar antes de M2).
