import { ArrowUpRight } from 'lucide-react';
import type { SharedPracticeBundle } from '../../../../../packages/collaboration/types';

export function CatalogPracticeSource({ source }: {
  source: NonNullable<SharedPracticeBundle['catalogSource']>;
}) {
  return source.sourceUrl ? (
    <a className="button button-quiet" href={source.sourceUrl} target="_blank" rel="noreferrer">
      {source.sourceName}
      <ArrowUpRight size={15} aria-hidden="true" />
    </a>
  ) : <p>{source.sourceName}</p>;
}
