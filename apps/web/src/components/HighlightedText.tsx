import { Fragment, memo } from 'react';
import type { TextSpan, SearchHit } from '@domain/index';
export const HighlightedText = memo(function HighlightedText({
  text,
  spans = [],
  hits = [],
}: {
  text: string;
  spans?: readonly Pick<TextSpan, 'start' | 'end'>[];
  hits?: readonly Pick<SearchHit, 'start' | 'end'>[];
}) {
  const chars = Array.from(text);
  const bounds = new Set([0, chars.length]);
  for (const r of [...spans, ...hits]) {
    bounds.add(Math.max(0, r.start));
    bounds.add(Math.min(chars.length, r.end));
  }
  const points = [...bounds].sort((a, b) => a - b);
  return (
    <>
      {points.slice(0, -1).map((start, i) => {
        const end = points[i + 1];
        const value = chars.slice(start, end).join('');
        const selected = spans.some((s) => s.start < end && s.end > start),
          search = hits.some((s) => s.start < end && s.end > start);
        return selected || search ? (
          <mark key={start} className={`text-highlight ${selected ? 'focus' : 'search'}`}>
            {value}
          </mark>
        ) : (
          <Fragment key={start}>{value}</Fragment>
        );
      })}
    </>
  );
});
