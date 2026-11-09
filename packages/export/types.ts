import type { RoadmapVersion } from '../roadmaps/types';
import type {
  AnalysisIssue,
  BudgetResult,
  CalendarResult,
  ScenarioResult,
} from '../analytics/types';
import type { RoadmapReadiness } from '../analytics/readiness';

export const ROADMAP_EXPORT_VERSION = 'roadmap-export-1' as const;
export type RoadmapExportFormat = 'docx' | 'pdf' | 'json' | 'zip';

export type FigurePrimitive =
  | {
      kind: 'line';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
      width: number;
      dash?: number[];
    }
  | {
      kind: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      fill: string;
      stroke?: string;
    }
  | { kind: 'circle'; x: number; y: number; radius: number; fill: string }
  | {
      kind: 'text';
      x: number;
      y: number;
      text: string;
      size: number;
      color: string;
      align?: 'start' | 'middle' | 'end';
      bold?: boolean;
    };
export interface RoadmapFigure {
  id: string;
  kind: 'scenario' | 'calendar';
  title: string;
  altText: string;
  width: number;
  height: number;
  primitives: FigurePrimitive[];
}
export type ReportBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | {
      kind: 'paragraph';
      text: string;
      role?: 'body' | 'meta' | 'quote' | 'warning';
      label?: string;
    }
  | {
      kind: 'table';
      caption: string;
      columns: Array<{ title: string; weight: number; align?: 'left' | 'right' | 'center' }>;
      rows: string[][];
    }
  | { kind: 'figure'; figure: RoadmapFigure };

export interface PreparedRoadmapExport {
  exportVersion: typeof ROADMAP_EXPORT_VERSION;
  version: RoadmapVersion;
  basename: string;
  title: string;
  subtitle: string;
  blocks: ReportBlock[];
  figures: RoadmapFigure[];
  readiness: RoadmapReadiness;
  budget: BudgetResult;
  calendar: CalendarResult;
  scenarios: Array<{
    itemId: string;
    title: string;
    result: ScenarioResult | null;
    error: string | null;
  }>;
  issues: AnalysisIssue[];
}

export interface ExportedRoadmapFile {
  blob: Blob;
  filename: string;
  mimeType: string;
}
/** The SVG is constructed internally from validated numerical data and escaped text. */
export interface DocxExportOptions {
  rasterizeSvg(svg: string, width: number, height: number): Promise<Uint8Array>;
}
/** Same-origin local files. Network access is intentionally outside the rendering kernel. */
export interface PdfExportFonts {
  regular: Uint8Array;
  bold: Uint8Array;
  license: string;
}
