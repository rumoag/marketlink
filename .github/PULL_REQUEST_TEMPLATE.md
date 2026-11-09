## Registro de cambio

**Que cambia y por que**

<!-- Una o dos frases. -->

**Riesgo** (marca uno)

- [ ] Bajo: texto, documentacion o refactor sin cambio de comportamiento
- [ ] Medio: cambio de comportamiento con pruebas
- [ ] Alto: dinero, autenticacion, migracion de base de datos o proveedores externos

**Migracion de base de datos**

- [ ] No incluye
- [ ] Incluye y es aditiva y compatible hacia atras (la version anterior de la aplicacion sigue funcionando)

**Nota de rollback** (obligatoria)

<!-- Como se deshace: promover el despliegue anterior de Vercel, migracion hacia delante, desactivar un flag... -->

**Comprobaciones**

- [ ] CI verde (tipos, lint, pruebas, integracion, build, auditoria, secretos)
- [ ] Sin secretos ni datos personales en el codigo, logs o pruebas
- [ ] Documentacion y ADR actualizados si procede

**Aprobacion**

- [ ] Aprobado por quien opera el producto
