// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RegionMap, type MapRegion } from '../../apps/web/src/components/geography/RegionMap';
import { RegionWorkView } from '../../apps/web/src/components/workshop/RegionWorkView';
import { loadRegionMap, type RegionMapData } from '../../apps/web/src/lib/region-map';

vi.mock('../../apps/web/src/lib/region-map', () => ({
  loadRegionMap: vi.fn(),
  loadRegionMapDetail: vi.fn(),
}));

const regions: MapRegion[] = [
  { id: 'moskva', name: 'Москва', hasDocument: false, hasMeasures: true },
  { id: 'respublika-mordoviia', name: 'Республика Мордовия', hasDocument: true, hasMeasures: true },
];
const geometry: RegionMapData = {
  schemaVersion: 1,
  viewBox: [0, 0, 1200, 620],
  projection: { name: 'Test projection', standardParallels: [50, 70], centralMeridian: 100, centerLatitude: 60 },
  source: { sourceUrl: 'https://example.test/regions', inputSha256: 'a'.repeat(64), licenseStatus: 'test' },
  shapes: regions.map((region, index) => ({
    regionId: region.id, name: region.name, featureId: `feature-${index}`,
    d: 'M10,10L30,10L30,30L10,30Z', centroid: [20 + index * 30, 20], bounds: [10, 10, 30, 30],
  })),
};
const mapProps = (items = regions) => ({
  regions: items, selectedRegionId: null, measureRegionIds: new Set(['moskva']), onSelect: vi.fn(),
});
const regionGroup = (id: string) => document.querySelector<SVGGElement>(`.geo-region[data-region-id="${id}"]`)!;
const pathFill = (id: string) => regionGroup(id).querySelector('path')!.getAttribute('fill');
const legend = () => document.querySelector('.geo-legend')!;

beforeEach(() => {
  vi.mocked(loadRegionMap).mockResolvedValue(geometry);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('programme map availability follows measure cards', () => {
  it('keeps regions with cards plain and selected regions green, including those without programme text', async () => {
    const props = mapProps();
    render(createElement(RegionMap, props));
    await screen.findByRole('group', { name: 'Карта региональных программ' });
    for (const region of regions) {
      expect(regionGroup(region.id).getAttribute('data-catalogue')).toBe('available');
      expect(pathFill(region.id)).toBeNull();
      expect(regionGroup(region.id).getAttribute('aria-label')).not.toMatch(/текст|Нет карточек/iu);
    }
    expect(regionGroup('moskva').classList.contains('geo-measures-selected')).toBe(true);
    expect(regionGroup('moskva').getAttribute('data-measures')).toBe('selected');
    expect(legend().textContent).toContain('Меры отобраны');
    expect(legend().textContent).not.toMatch(/Нет карточек|Нет подготовленного текста/u);
    fireEvent.keyDown(regionGroup('moskva'), { key: 'Enter' });
    expect(props.onSelect).toHaveBeenCalledWith('moskva');
  });

  it('hatches only confirmed absence of cards, even if text exists or measures were previously selected', async () => {
    const items = regions.map(region => ({ ...region, hasDocument: true, hasMeasures: false }));
    render(createElement(RegionMap, mapProps(items)));
    await screen.findByRole('group', { name: 'Карта региональных программ' });
    expect(regionGroup('moskva').getAttribute('data-catalogue')).toBe('unavailable');
    expect(regionGroup('moskva').getAttribute('data-measures')).toBe('selected');
    expect(pathFill('moskva')).toMatch(/-selected\)$/u);
    expect(pathFill('respublika-mordoviia')).toMatch(/^url\(#.+\)$/u);
    expect(regionGroup('moskva').getAttribute('aria-label')).toContain('Нет карточек мер');
    expect(legend().textContent).toContain('Нет карточек мер');
    expect(legend().textContent).not.toContain('Нет подготовленного текста');
  });

  it('does not report missing cards while coverage is loading and updates the legend once coverage resolves', async () => {
    const pending = regions.map(({ hasMeasures: _hasMeasures, ...region }) => region);
    const mounted = render(createElement(RegionMap, mapProps(pending)));
    await screen.findByRole('group', { name: 'Карта региональных программ' });
    expect(regionGroup('moskva').hasAttribute('data-catalogue')).toBe(false);
    expect(pathFill('moskva')).toBeNull();
    expect(legend().textContent).not.toContain('Нет карточек мер');
    mounted.rerender(createElement(RegionMap, mapProps(regions.map(region => ({ ...region, hasMeasures: false })))));
    expect(pathFill('moskva')).toMatch(/-selected\)$/u);
    expect(legend().textContent).toContain('Нет карточек мер');
    mounted.rerender(createElement(RegionMap, mapProps()));
    expect(pathFill('moskva')).toBeNull();
    expect(legend().textContent).not.toContain('Нет карточек мер');
  });

  it('retains document-text hatching in the separate document reader map', async () => {
    render(createElement(RegionMap, { regions, selectedRegionId: null, onSelect: vi.fn(), allocation: false }));
    await screen.findByRole('group', { name: 'Карта региональных программ' });
    expect(pathFill('moskva')).toMatch(/^url\(#.+\)$/u);
    expect(pathFill('respublika-mordoviia')).toBeNull();
    expect(regionGroup('moskva').getAttribute('aria-label')).toContain('Нет подготовленного текста');
    expect(legend().textContent).toContain('Нет подготовленного текста');
    expect(legend().textContent).not.toContain('Нет карточек мер');
  });
});

describe('programme list availability follows measure cards', () => {
  const props = (items = regions) => ({
    regions: items, renderMap: vi.fn(() => null), onOpenDocument: vi.fn(), measureRegionIds: new Set(['moskva']),
    renderCatalogue: vi.fn((regionId: string) => createElement('section', { 'aria-label': 'Открытый каталог' }, regionId)),
  });
  const row = (id: string) => document.querySelector<HTMLButtonElement>(`.workshop-region-row[data-region-id="${id}"]`)!;

  it('opens cards for a region without text while keeping its selected state and omitting the old badge', async () => {
    const actions = props();
    render(createElement(RegionWorkView, actions));
    const list = screen.getByRole('group', { name: 'Выбрать программу по названию' });
    expect(within(list).queryByText('Текст недоступен')).toBeNull();
    expect(within(list).queryByText('Нет карточек мер')).toBeNull();
    expect(row('moskva').disabled).toBe(false);
    expect(row('moskva').getAttribute('data-catalogue')).toBe('available');
    expect(row('moskva').getAttribute('data-measures')).toBe('selected');
    fireEvent.click(row('moskva'));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Открытый каталог' }).textContent).toBe('moskva'));
    expect(actions.onOpenDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'К карте и списку программ' }));
    expect(row('moskva').getAttribute('data-measures')).toBe('selected');
  });

  it('shows missing-card status only after coverage resolves to false', () => {
    const pending = regions.map(({ hasMeasures: _hasMeasures, ...region }) => region);
    const actions = props(pending);
    const mounted = render(createElement(RegionWorkView, actions));
    expect(row('moskva').hasAttribute('data-catalogue')).toBe(false);
    expect(screen.queryByText('Текст недоступен')).toBeNull();
    expect(screen.queryByText('Нет карточек мер')).toBeNull();
    mounted.rerender(createElement(RegionWorkView, { ...actions,
      regions: regions.map(region => ({ ...region, hasMeasures: region.id !== 'moskva' })),
    }));
    expect(row('moskva').getAttribute('data-catalogue')).toBe('unavailable');
    expect(within(row('moskva')).getByText('Нет карточек мер')).toBeTruthy();
    expect(row('respublika-mordoviia').getAttribute('data-catalogue')).toBe('available');
    expect(screen.queryByText('Текст недоступен')).toBeNull();
  });

  it('keeps the document-only list text hint and unavailable document guard', () => {
    render(createElement(RegionWorkView, { ...props(), renderCatalogue: undefined }));
    expect(row('moskva').disabled).toBe(true);
    expect(within(row('moskva')).getByText('Текст недоступен')).toBeTruthy();
    expect(row('respublika-mordoviia').disabled).toBe(false);
  });
});
