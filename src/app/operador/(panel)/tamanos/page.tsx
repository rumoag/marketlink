import { notFound } from 'next/navigation';
import { requireOperator, requireServices } from '@/ui/server-context';
import { saveSizesAction } from '../actions';
import { OperatorActionForm, type OperatorField } from '../operator-form';

export const dynamic = 'force-dynamic';

export default async function OperadorTamanosPage() {
  const actor = await requireOperator();
  const operator = requireServices().operator;
  if (!operator) notFound();
  const sizes = await operator.sizes.execute(actor);
  if (!sizes.ok) notFound();

  const fields: OperatorField[] = sizes.value.flatMap((s) => [
    {
      name: `${s.size}_largo`,
      label: `${s.size}: largo (cm)`,
      inputMode: 'numeric',
      maxLength: 3,
      defaultValue: String(s.lengthCm),
    },
    {
      name: `${s.size}_ancho`,
      label: `${s.size}: ancho (cm)`,
      inputMode: 'numeric',
      maxLength: 3,
      defaultValue: String(s.widthCm),
    },
    {
      name: `${s.size}_alto`,
      label: `${s.size}: alto (cm)`,
      inputMode: 'numeric',
      maxLength: 3,
      defaultValue: String(s.heightCm),
    },
    {
      name: `${s.size}_peso`,
      label: `${s.size}: peso (kg)`,
      inputMode: 'decimal',
      maxLength: 5,
      defaultValue: String(s.weightKg).replace('.', ','),
    },
  ]);

  return (
    <>
      <h1 data-testid="op-tamanos-title" className="text-2xl font-semibold">
        Tamaños predefinidos
      </h1>
      <p>
        Medidas y pesos de S, M y L. Los cambios solo afectan a los enlaces que se creen o se editen
        después; los pedidos ya creados conservan sus medidas.
      </p>
      <OperatorActionForm
        action={saveSizesAction}
        testId="op-tamanos"
        submitLabel="Guardar tamaños"
        fields={fields}
      />
    </>
  );
}
