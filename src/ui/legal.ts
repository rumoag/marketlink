import { loadConfig } from '@/modules/platform/application/config';
import { privacyFacts, type PrivacyFacts } from '@/modules/operator/domain/health';

/** Datos de los textos legales, tomados de la configuración (BR7-PD7): plazos y contacto reales. */
export const legalFacts = (env: NodeJS.ProcessEnv = process.env): PrivacyFacts => {
  const loaded = loadConfig(env);
  if (loaded.ok) {
    const c = loaded.value;
    return privacyFacts({
      personalMonths: c.retention.personalMonths,
      unpaidDays: c.retention.unpaidDays,
      financialYears: c.retention.financialYears,
      contactEmail: c.contactEmail,
    });
  }
  return privacyFacts({
    personalMonths: 12,
    unpaidDays: 30,
    financialYears: 6,
    contactEmail: 'contacto@example.com',
  });
};
