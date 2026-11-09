# ADR 0008: Versiones fijadas de TypeScript y ESLint

- Estado: aceptado
- Fecha: 2026-11-04
- Unidad: U1 Fundación

## Contexto

`tech-stack-decisions.md` partía de TypeScript 7.0.2 y ESLint 10.14.0, con la advertencia de validar la compatibilidad al instalar.

## Hallazgos

- `typescript-eslint@8.72.1` declara el peer `typescript >=4.8.4 <6.1.0`: **no admite TypeScript 7**.
- `eslint-plugin-jsx-a11y@6.10.2` declara peers de ESLint hasta la 9: **no admite ESLint 10**.

## Decisión

- TypeScript **6.0.3** (última 6.x).
- ESLint **9.39.5** (última 9.x) con `@eslint/js` de la misma versión.
- Resto de versiones sin cambios (Next 16.4.5, React 19.3.1, Zod 4.6.7, Vitest 5.1.0, fast-check 4.10.2, Playwright 1.64.1, Prettier 3.9.10, Tailwind 4.3.4, Pino 10.4.0).

## Consecuencias

- `npm audit` informa de 20 avisos de severidad **moderada**, todos en dependencias de desarrollo (minimatch dentro de ESLint, typescript-eslint y el generador de SBOM). **Dependencias de producción: 0 avisos.**
- La puerta de CI es `npm audit --omit=dev --audit-level=high`. El informe completo se publica como artefacto y se revisa con Dependabot.
- `libxmljs2` (dependencia del generador de SBOM) tiene script de instalación que no se ejecuta; el SBOM se genera en JSON y no lo necesita.

## Revisión

Reevaluar la subida a TypeScript 7 y ESLint 10 cuando `typescript-eslint` y `eslint-plugin-jsx-a11y` los declaren compatibles.
