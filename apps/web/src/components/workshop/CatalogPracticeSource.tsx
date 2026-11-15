import { ArrowUpRight } from 'lucide-react';
import { FAMILY_SUPPORT_NAME, FAMILY_SUPPORT_URL } from '@/lib/family-catalog';
import type { SharedPracticeBundle } from '../../../../../packages/collaboration/types';

export function CatalogPracticeSource(_: {
  source: NonNullable<SharedPracticeBundle['catalogSource']>;
}) {
  return (
    <a className="button button-quiet" href={FAMILY_SUPPORT_URL} target="_blank" rel="noopener noreferrer">
      {FAMILY_SUPPORT_NAME}
      <ArrowUpRight size={15} aria-hidden="true" />
    </a>
  );
}
