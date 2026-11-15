import type { RoadmapPassportData } from './types';

export const passportResources = [
  { key: 'normativeResources', label: 'Нормативно-правовой ресурс', hint: 'Законы, подзаконные акты, стратегии и программы в области демографии' },
  { key: 'managementResources', label: 'Организационно-управленческий ресурс', hint: 'Органы власти, структуры управления демографическими процессами' },
  { key: 'researchResources', label: 'Образовательно-научный ресурс', hint: 'Научные знания, образовательные программы, исследовательский потенциал' },
  { key: 'humanResources', label: 'Кадровый ресурс', hint: 'Специалисты и эксперты в области демографии и социальной политики' },
  { key: 'economicResources', label: 'Экономический ресурс', hint: 'Бюджетные средства, финансовые механизмы поддержки демографии' },
  { key: 'demographicResources', label: 'Социально-демографический ресурс', hint: 'Население как объект и субъект демографических процессов' },
  { key: 'materialResources', label: 'Инфраструктурный ресурс', hint: 'Медицинская, социальная, образовательная инфраструктура' },
  { key: 'institutionalResources', label: 'Институциональный ресурс', hint: 'Институты брака, семьи, образования, здравоохранения, культуры' },
  { key: 'informationResources', label: 'Информационный ресурс', hint: 'Системы мониторинга, базы данных, аналитические материалы' },
  { key: 'technologyResources', label: 'Технологический ресурс', hint: 'ИТ-системы, цифровые платформы, инновационные решения' },
] as const satisfies ReadonlyArray<{ key: keyof RoadmapPassportData; label: string; hint: string }>;
