import type { RichVariant } from './corpus';

export function implementationLabel(variant: RichVariant): string | null {
  switch (variant.implementationStatus) {
    case 'described-existing':
      return 'Описана в программе как существующая';
    case 'proposed':
      return 'Предложение программы';
    case 'recommended':
      return 'Рекомендация программы';
    case 'period-ended-in-source':
      return 'В источнике указан завершённый период меры';
    default:
      return null;
  }
}
