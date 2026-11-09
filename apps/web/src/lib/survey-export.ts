import { zipSync, strToU8 } from 'fflate';
import type { SurveyResearchExport } from '../../../../packages/barriers/types';

const columns = [
  'record',
  'questionVersion',
  'responseDate',
  'perspective',
  'intention12m',
  'intention36m',
  'answerBarrier',
  'answerSupport',
  'priorityChange',
  'horizon',
  'conditionalChange',
  'additionalConditions',
  'consentResearch',
  'consentQuote',
  'missingReasons',
] as const;
/** Formula escaping is restricted to CSV; JSON retains the respondent's exact strings. */
export function safeCsvCell(value: unknown): string {
  let text =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = "'" + text;
  return '"' + text.replace(/"/gu, '""') + '"';
}
export function researchCsv(data: SurveyResearchExport): string {
  return (
    '\uFEFF' +
    [
      columns.map(safeCsvCell).join(';'),
      ...data.records.map((record, i) =>
        columns
          .map((key) =>
            safeCsvCell(key === 'record' ? `R${String(i + 1).padStart(3, '0')}` : record[key]),
          )
          .join(';'),
      ),
    ].join('\r\n') +
    '\r\n'
  );
}
export function researchArchive(data: SurveyResearchExport): Uint8Array {
  const readme = `# Исследовательская выгрузка\n\nДата выгрузки: ${data.exportDate}. Ответов с действующим согласием: ${data.records.length}.\n\n${data.samplingNote}\n\nrecords.json хранит исходные строки и служебные коды; records.csv — представление для таблиц с защитой от интерпретации текста как формул. Префикс апострофа добавляется только в CSV. Метки R001 и далее действуют только внутри этой выгрузки и не идентифицируют людей.\n\nquestionnaire.json содержит формулировки, версию и процедуру. null означает пропуск; missingReasons различает skipped и not_asked. decline и not_applicable являются ответами и не заменяются пропуском.\n\nВключены только ответы, для которых consentResearch=true на момент выгрузки. Дословное цитирование требует отдельного consentQuote=true и редакционной проверки обезличивания. Согласие на цитирование само по себе не устраняет идентифицирующие сведения из текста.\n\nОтветы о собственных намерениях, сведения со слов совершеннолетних детей, предположения о детях и профессиональные наблюдения разделены perspective. Изменение ответа на гипотетическое условие не является оценкой причинного эффекта меры. Выборка формируется по общей открытой ссылке; число форм не гарантирует число уникальных людей.\n\nЛичные ключи, учебные учётные записи, IP/UA и точные времена отправки в выгрузку не включаются. Отзыв согласия после скачивания требует обновить ранее полученные копии в исследовательском процессе.\n`;
  return zipSync({
    'records.json': strToU8(JSON.stringify(data, null, 2)),
    'records.csv': strToU8(researchCsv(data)),
    'questionnaire.json': strToU8(JSON.stringify(data.questionnaire, null, 2)),
    'README.md': strToU8(readme),
  });
}
export function downloadBytes(bytes: Uint8Array, filename: string, type = 'application/zip') {
  const blob = new Blob([new Uint8Array(bytes)], { type }),
    url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
