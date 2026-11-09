/** Shared by the dependency-free Node seed and browser. Identity is independent of object key order. */
export function canonicalSeriesText(series) {
  return JSON.stringify([
    'canonical-municipal-series-1', series.id, series.territoryKey, series.metricId, series.title,
    series.unit, series.semanticType, series.valueDomain, series.aggregation, series.decimals,
    series.reference, series.sourceEditionId, series.sourceUrl, series.sourcePath,
    series.sourceSha256, series.sourceCommit, series.sourceKind, series.provenanceStatus,
    series.sourceMunicipalityKey, series.geographyEditionId, series.geographyComparability,
    series.comparabilityNote, series.points.map((point) => [point.year, point.value]),
  ]);
}

export async function canonicalSeriesFingerprint(series) {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalSeriesText(series)));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyCanonicalSeriesFingerprint(series) {
  return /^[a-f0-9]{64}$/u.test(series.fingerprint) && series.fingerprint === await canonicalSeriesFingerprint(series);
}

/** Inputs must be schema-validated and their file SHA-256 verified against the loaded index. */
export async function adaptCanonicalSeries(index, registry, pack) {
  if (index.schemaVersion !== 1 || registry.schemaVersion !== 1 || pack.schemaVersion !== 1
    || index.editionId !== registry.editionId || index.editionId !== pack.editionId
    || index.geographyEditionId !== pack.geographyEditionId || index.statisticsEditionId !== pack.statisticsEditionId
    || pack.geographyComparability !== 'not_verified' || pack.provenanceStatus !== 'incomplete_primary'
    || !index.regions.some((region) => region.regionId === pack.regionId)) {
    throw new Error('Редакции территорий и статистики не совпадают.');
  }
  const source = index.sources.find((entry) => entry.id === pack.sourceId);
  if (!source || !/^[a-f0-9]{64}$/u.test(source.sha256) || source.provenanceStatus !== 'incomplete_primary') {
    throw new Error('Не установлен паспорт статистического источника.');
  }
  const territories = new Map(registry.records.map((territory) => [territory.territoryKey, territory]));
  const encountered = new Set();
  const result = [];
  for (const group of pack.series) {
    const territory = territories.get(group.territoryKey);
    if (!territory || territory.level !== 'municipality' || territory.regionId !== pack.regionId
      || territory.statistics.status !== 'matched' || !territory.statistics.hasSeries
      || territory.statistics.sourceMunicipalityKey !== group.sourceMunicipalityKey
      || encountered.has(group.territoryKey)) throw new Error('Статистический ряд привязан к несовместимой территории.');
    encountered.add(group.territoryKey);
    for (const metric of index.metrics) {
      const column = pack.columns.indexOf(metric.id);
      if (column < 1) throw new Error('В статистическом наборе отсутствует объявленный показатель.');
      const points = group.rows.map((row) => ({ year: row[0], value: row[column] }));
      if (!points.some((point) => point.value !== null)) continue;
      let previousYear = 0;
      for (const point of points) {
        if (!Number.isSafeInteger(point.year) || point.year <= previousYear || point.year < 1900 || point.year > 2100
          || (point.value !== null && (!Number.isFinite(point.value) || Math.abs(point.value) > 1e12
            || (!metric.signed && point.value < 0)))) throw new Error('Недопустимые годы или значения статистического ряда.');
        previousYear = point.year;
      }
      const knownIssue = group.sourceMunicipalityKey === '89701000__1585ce3d' && metric.id === 'pop_mid'
        ? index.warnings.find((warning) => warning.startsWith('Саранск, pop_mid:')) ?? ''
        : '';
      const series = {
        id: `${index.editionId}:${territory.territoryKey}:${metric.id}`,
        territoryKey: territory.territoryKey, metricId: metric.id, title: metric.label, unit: metric.unit,
        semanticType: metric.kind, valueDomain: metric.signed ? 'signed' : 'nonnegative',
        aggregation: metric.kind === 'flow' ? 'sum' : 'none', decimals: metric.id === 'pop_mid' ? 1 : 0,
        reference: metric.reference, sourceEditionId: pack.statisticsEditionId, sourceUrl: source.url,
        sourcePath: source.sourcePath, sourceSha256: source.sha256, sourceCommit: source.commit,
        sourceKind: metric.sourceKind, provenanceStatus: 'incomplete_primary',
        sourceMunicipalityKey: group.sourceMunicipalityKey, geographyEditionId: pack.geographyEditionId,
        geographyComparability: 'not_verified',
        comparabilityNote: 'Ряд из авторского набора actual. Соответствие названия и типа территории проверено; первичная выгрузка, историческое тождество границ и гармонизация ряда отдельно не подтверждены. Пропуски сохраняются. ' + metric.definition + (knownIssue ? ' ' + knownIssue : ''),
        points,
      };
      result.push({ ...series, fingerprint: await canonicalSeriesFingerprint(series) });
    }
  }
  return result;
}
