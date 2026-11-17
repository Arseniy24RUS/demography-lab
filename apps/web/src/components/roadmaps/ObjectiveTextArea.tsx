import type { TextareaHTMLAttributes } from 'react';

/** The hidden mirror grows with existing text and viewport width, without changing draft state. */
export function ObjectiveTextArea({ value, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'defaultValue'> & {
  value: string;
}) {
  return <div className="rm-objective-input">
    <textarea {...props} value={value} rows={1} />
    <div className="rm-objective-mirror" aria-hidden="true">{value + ' '}</div>
  </div>;
}
