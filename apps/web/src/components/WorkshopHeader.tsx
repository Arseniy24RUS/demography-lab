import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { BookOpen, ChartNoAxesCombined, ChevronDown, ClipboardList, Layers, Map,
  Menu, Route, Shapes, SquareLibrary, X } from 'lucide-react';
import { isFactorStage, type ReferenceView, type WorkshopStage } from '@/lib/workshop-navigation';
import './workshop-header.css';

const stages = [
  ['flipchart', 'Факторы', Layers],
  ['barriers', 'Барьеры', Shapes],
  ['regions', 'Программы', ClipboardList],
  ['board', 'Практики', SquareLibrary],
  ['solutions', 'Решения', ChartNoAxesCombined],
  ['roadmaps', 'Дорожная карта', Route],
] as const;
const references = [
  ['documents', 'Документы'], ['practices', 'Каталог практик'],
  ['territories', 'Территории'], ['work', 'Моя работа'],
] as const;

export function WorkshopHeader({ activeStage, reference, onStage, onHome, onReference, account, tools }: {
  activeStage?: WorkshopStage;
  reference?: ReferenceView;
  onStage(stage: WorkshopStage): void;
  onHome(): void;
  onReference(view: ReferenceView): void;
  account: ReactNode;
  tools: ReactNode;
}) {
  const id = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const header = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const materialsButton = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLDivElement>(null);
  const mobile = () => window.matchMedia('(max-width: 860px)').matches;
  useEffect(() => {
    if (!menuOpen && !materialsOpen) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !header.current?.contains(event.target)) {
        setMenuOpen(false);
        setMaterialsOpen(false);
      }
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !header.current?.contains(document.activeElement)) return;
      event.preventDefault();
      if (materialsOpen) {
        setMaterialsOpen(false);
        materialsButton.current?.focus();
      } else if (menuOpen && mobile()) {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [menuOpen, materialsOpen]);

  function finishNavigation() {
    if (mobile() && nav.current?.contains(document.activeElement)) menuButton.current?.focus({ preventScroll: true });
    setMenuOpen(false);
    setMaterialsOpen(false);
  }
  return <header className="workshop-header" ref={header}>
    <div className="workshop-header-main">
      <button type="button" className="workshop-header-brand" aria-label="Мастерская" onClick={() => {
        finishNavigation(); onHome();
      }}>
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} width={40} height={40}
          alt="Институт социальной демографии ФНИСЦ РАН" />
        <span>Демографическая мастерская</span>
      </button>
      <button className="workshop-header-toggle" type="button" ref={menuButton}
        aria-expanded={menuOpen} aria-controls={`${id}-navigation`}
        onClick={() => {
          if (menuOpen) setMaterialsOpen(false);
          setMenuOpen(!menuOpen);
        }}>
        {menuOpen ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}Меню
      </button>
      <div className="workshop-header-utilities">{account}<div className="workshop-header-tools">{tools}</div></div>
    </div>
    <div id={`${id}-navigation`} className="workshop-header-navigation" data-open={menuOpen} ref={nav}>
      <nav className="workshop-header-stages" aria-label="Этапы коллективной работы">
        {stages.map(([key, label, Icon]) => {
          const active = activeStage && (key === 'flipchart' ? isFactorStage(activeStage) : activeStage === key);
          return <button type="button" key={key} aria-current={active ? 'page' : undefined}
            onClick={() => { finishNavigation(); onStage(key); }}>
            <Icon size={17} aria-hidden="true" /><span>{label}</span>
          </button>;
        })}
      </nav>
      <div className="workshop-header-materials">
        <button type="button" className="workshop-materials-toggle" ref={materialsButton}
          aria-expanded={materialsOpen} aria-controls={`${id}-materials`}
          onClick={() => setMaterialsOpen(!materialsOpen)}>
          <BookOpen size={16} aria-hidden="true" />Материалы<ChevronDown size={14} aria-hidden="true" />
        </button>
        <nav className="workshop-materials-links" aria-label="Основная навигация"
          id={`${id}-materials`} hidden={!materialsOpen}>
          {references.map(([key, label]) =>
            <button type="button" key={key} aria-current={key === reference ? 'page' : undefined} onClick={() => {
              if (!mobile()) materialsButton.current?.focus({ preventScroll: true });
              finishNavigation(); onReference(key);
            }}>{key === 'territories' ? <Map size={16} aria-hidden="true" /> : null}{label}</button>)}
        </nav>
      </div>
    </div>
  </header>;
}
