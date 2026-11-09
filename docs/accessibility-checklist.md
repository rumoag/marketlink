# Lista de comprobaciones de accesibilidad (WCAG AA)

Axe en CI cubre las pantallas públicas, el área de la artista y el panel (`tests/e2e/transversales.spec.ts`; para cubrir una pantalla nueva se añade su ruta a la lista). Axe no detecta todo: esta lista manual se pasa **antes de M2** y tras cambios grandes de interfaz.

## Dispositivos y navegadores

- [ ] iPhone con Safari (flujo de compra completo).
- [ ] Android con Chrome.
- [ ] Firefox de escritorio.
- [ ] Un lector de pantalla (VoiceOver en iPhone o NVDA) en el flujo de compra.

## Comprobaciones

- [ ] Se puede completar la compra solo con el teclado (Tab, Mayús+Tab, Intro, Espacio).
- [ ] El foco es siempre visible y el orden es lógico; tras enviar un formulario el foco va al mensaje.
- [ ] Todos los campos tienen etiqueta visible; los errores se anuncian y se asocian a su campo.
- [ ] Contraste suficiente (texto 4,5:1; texto grande y componentes 3:1), también en modo oscuro.
- [ ] Objetivos táctiles de al menos 44 × 44 px.
- [ ] El estado nunca se transmite solo con color (salud, atascos, errores).
- [ ] La página funciona al ampliar el texto al 200 % y en vertical a 320 px de ancho.
- [ ] Las imágenes de obras tienen texto alternativo con el título.
- [ ] Los mensajes de estado (`role="status"` / `role="alert"`) se leen sin mover el foco.

## Registro

| Fecha | Persona | Dispositivo / navegador | Resultado | Incidencias |
| ----- | ------- | ----------------------- | --------- | ----------- |
|       |         |                         |           |             |
