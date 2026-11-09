import fc from 'fast-check';

/**
 * PBT-08: la semilla se registra en cada ejecucion (tambien en CI) y se puede reproducir con
 * FC_SEED=<numero>. fast-check la imprime ademas junto a cada contraejemplo reducido.
 */
const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : Date.now() % 2 ** 31;
const numRuns = process.env.FC_RUNS ? Number(process.env.FC_RUNS) : 200;

fc.configureGlobal({ seed, numRuns });

console.info(`[fast-check] seed=${seed} numRuns=${numRuns}`);
