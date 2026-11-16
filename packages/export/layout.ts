export const roadmapLayout = {
  page: { width: 210, height: 297 },
  margin: { top: 20, right: 10, bottom: 20, left: 20, header: 10 },
  firstLineIndent: 12.5,
  font: 'Times New Roman',
  bodySize: 14,
  tableSize: 12,
  lineSpacing: 1.5,
};

export const points = (millimeters: number) => (millimeters * 72) / 25.4;
export const twips = (millimeters: number) => Math.round(points(millimeters) * 20);
