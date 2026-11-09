import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import nextPlugin from '@next/eslint-plugin-next';

export default tseslint.config(
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'scripts/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
      'sbom.cdx.json',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      // Sin console en codigo de servidor: todo pasa por el Logger (SECURITY-03).
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: { 'jsx-a11y': jsxA11y },
    rules: { ...jsxA11y.flatConfigs.recommended.rules },
  },
  {
    files: ['src/app/**/*.{ts,tsx}', 'middleware.ts'],
    plugins: { '@next/next': nextPlugin },
    rules: { ...nextPlugin.configs['core-web-vitals'].rules },
  },
  // Capas: el dominio es puro y no depende de infraestructura ni de librerias de E/S.
  {
    files: ['src/modules/*/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure/**', '**/application/**'],
              message: 'El dominio no depende de otras capas.',
            },
          ],
          paths: [
            { name: 'pg', message: 'El dominio no accede a la base de datos.' },
            { name: '@supabase/supabase-js', message: 'Los SDK solo se usan en infraestructura.' },
            { name: '@supabase/ssr', message: 'Los SDK solo se usan en infraestructura.' },
            { name: 'stripe', message: 'Los SDK solo se usan en infraestructura.' },
            { name: 'sharp', message: 'Las librerias de imagen solo se usan en infraestructura.' },
            { name: 'pdf-lib', message: 'La generacion de PDF solo se usa en infraestructura.' },
            { name: 'pino', message: 'El dominio no registra logs directamente.' },
            { name: 'next/server', message: 'El dominio no depende de Next.js.' },
            { name: 'next/headers', message: 'El dominio no depende de Next.js.' },
          ],
        },
      ],
    },
  },
  // Aplicacion: depende de dominio y puertos, no de infraestructura.
  {
    files: ['src/modules/*/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure/**'],
              message: 'La aplicacion usa puertos, no adaptadores.',
            },
          ],
          paths: [
            { name: 'pg', message: 'La base de datos solo se usa en infraestructura.' },
            { name: '@supabase/supabase-js', message: 'Los SDK solo se usan en infraestructura.' },
            { name: '@supabase/ssr', message: 'Los SDK solo se usan en infraestructura.' },
            { name: 'stripe', message: 'Los SDK solo se usan en infraestructura.' },
            { name: 'sharp', message: 'Las librerias de imagen solo se usan en infraestructura.' },
            { name: 'pdf-lib', message: 'La generacion de PDF solo se usa en infraestructura.' },
          ],
        },
      ],
    },
  },
  // U3 (NFR-U3 Q1 A): las rutas y paginas publicas nunca abren el contexto de sistema ni tocan
  // repositorios; solo llaman a servicios, que son quienes acotan el acceso anonimo.
  {
    files: ['src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/modules/platform/application/unit-of-work',
              message: 'Las rutas usan servicios; el contexto de sistema solo lo abren ellos.',
            },
            { name: 'pg', message: 'La base de datos solo se usa en infraestructura.' },
          ],
          patterns: [
            {
              group: ['**/infrastructure/pg-*', '**/infrastructure/*-repositories'],
              message: 'Las rutas no acceden a repositorios.',
            },
          ],
        },
      ],
    },
  },
  // Pruebas: se permiten aserciones no nulas y variables sin usar con guion bajo.
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
);
