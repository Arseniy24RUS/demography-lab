import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import { readable } from '@/lib/corpus';
import type { CorpusManifest } from '@/lib/corpus';
import { RegionMap } from './RegionMap';

export function LocalAtlas({ manifest, initialRegionId, onOpen }: { manifest: CorpusManifest; initialRegionId: string; onOpen: (documentId: string) => void }) {
  const [selected, setSelected] = useState(initialRegionId);
  const entry = manifest.documents.find((item) => item.regionId === selected) ?? manifest.documents[0];
  const regions = manifest.documents.map((item) => ({ id: item.regionId, name: item.territory, hasDocument: readable(item) }));
  return <section className="local-atlas">
    <p>Выберите программу для чтения. Назначения участников и состояние отбора отображаются в учебном занятии.</p>
    <div className="local-atlas-layout"><RegionMap regions={regions} selectedRegionId={entry.regionId} onSelect={setSelected} allocation={false} />
      <aside className="local-atlas-inspector"><label className="local-atlas-select">Регион<select value={entry.regionId} onChange={(event) => setSelected(event.target.value)}>{[...regions].sort((a, b) => a.name.localeCompare(b.name, 'ru')).map((region) => <option key={region.id} value={region.id}>{region.name}</option>)}</select></label>
        <h3>{entry.territory}</h3><p>{entry.title}</p><p>{readable(entry) ? `Подготовлено страниц: ${entry.pageCount}.` : 'Полный текст пока не подготовлен. Паспорт источника доступен в библиотеке.'}</p>
        {entry.quality === 'partial' || entry.extractionWarnings?.length ? <p className="notice warning">В исходном файле или извлечении есть ограничения. Проверьте паспорт источника.</p> : null}
        <button className="button button-primary" onClick={() => onOpen(entry.id)}><BookOpen size={17} />{readable(entry) ? 'Открыть программу' : 'Открыть паспорт'}</button>
      </aside></div>
  </section>;
}
