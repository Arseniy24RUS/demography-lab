import { useEffect, useState } from 'react';
import { TerritoryPanel, useTerritoryDataset } from './TerritoryPanel';
import { DiagnosticWorkbench } from './DiagnosticWorkbench';
import { Note } from './common';
import '../../roadmaps.css';

export function TerritoryExplorer({ onOpenSession }: { onOpenSession(): void }) {
  const data = useTerritoryDataset(),
    [selectedKey, setSelectedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedKey && data.registry)
      setSelectedKey(
        data.registry.records.find(
          (record) => record.regionId === 'respublika-mordoviia' && record.name.includes('Саранск'),
        )?.territoryKey ?? null,
      );
  }, [data.registry, selectedKey]);
  const territory = data.registry?.records.find((record) => record.territoryKey === selectedKey);
  return (
    <main id="main-content" className="rm-public-page">
      <div className="rm-public-intro">
        <Note>
          Открытый просмотр источников. Для общей дорожной карты, сохранения командных результатов и
          экспорта версии откройте учебное занятие.
        </Note>
        <button className="button button-primary" onClick={onOpenSession}>
          Открыть совместное занятие
        </button>
      </div>
      {data.error ? (
        <div className="rm-empty">
          <p role="alert">{data.error}</p>
          <button className="button button-secondary" onClick={data.retry}>
            Повторить загрузку
          </button>
        </div>
      ) : data.index && data.registry ? (
        <>
          <TerritoryPanel
            index={data.index}
            registry={data.registry}
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            publicMode
          />
          {territory ? (
            <div className="rm-public-analysis">
              <DiagnosticWorkbench
                key={territory.territoryKey}
                index={data.index}
                registry={data.registry}
                territory={territory}
              />
            </div>
          ) : null}
        </>
      ) : (
        <p className="rm-empty" aria-busy="true">
          Загружаем реестр территорий…
        </p>
      )}
    </main>
  );
}
