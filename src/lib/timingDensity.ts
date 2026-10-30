// What the timing table gives up as the split divider narrows it, in order:
// thinner minisector bars, a compressed driver column, no PIT column, no tire
// column. Level 4 is the floor, so the drag never clips content.
//
// TimingBoard (header) and DriverRow (rows) both build their grid from here so
// the two cannot drift out of alignment.

export const DENSITY_LEVELS = [0, 1, 2, 3, 4] as const;

export type Density = (typeof DENSITY_LEVELS)[number];

export interface DensityLevel {
  /** Width of one minisector bar. `gap-1` adds SEGMENT_GAP between them. */
  bar: number;
  /** Width of the position + driver code column. */
  driver: number;
  pit: boolean;
  tire: boolean;
}

export const DENSITY: Record<Density, DensityLevel> = {
  0: { bar: 16, driver: 95, pit: true, tire: true },
  1: { bar: 9, driver: 95, pit: true, tire: true },
  2: { bar: 9, driver: 70, pit: true, tire: true },
  3: { bar: 9, driver: 70, pit: false, tire: true },
  4: { bar: 9, driver: 70, pit: false, tire: false },
};

/** `gap-1` between minisector bars. */
const SEGMENT_GAP = 4;
/** `gap-3` between grid columns. */
const COLUMN_GAP = 12;
/** `px-3` on the row. */
const ROW_PADDING = 24;

const GAP_COLUMN = 72;
const LAST_COLUMN = 90;
const PIT_COLUMN = 47;
const TIRE_COLUMN = 99;

export interface SectorCounts {
  s1: number;
  s2: number;
  s3: number;
}

/** Minisector count per sector, from whichever driver has reported segments. */
export function sectorCounts(driver?: {
  sector1SegmentCount?: number;
  sector2SegmentCount?: number;
  sector3SegmentCount?: number;
}): SectorCounts {
  return {
    s1: driver?.sector1SegmentCount || 6,
    s2: driver?.sector2SegmentCount || 6,
    s3: driver?.sector3SegmentCount || 6,
  };
}

/** Width one minisector occupies, bar plus the gap after it. */
export function segmentWidth(level: Density): number {
  return DENSITY[level].bar + SEGMENT_GAP;
}

/** Cap on bar stretch: the `1fr` sector columns hand over any surplus, and
 *  without a limit the bars read as blocks rather than segments. */
export function maxBarWidth(level: Density): number {
  return DENSITY[level].bar + 10;
}

function columnWidths(level: Density, counts: SectorCounts): number[] {
  const { driver, pit, tire } = DENSITY[level];
  const segment = segmentWidth(level);

  return [
    driver,
    ...(pit ? [PIT_COLUMN] : []),
    ...(tire ? [TIRE_COLUMN] : []),
    GAP_COLUMN,
    LAST_COLUMN,
    counts.s1 * segment,
    counts.s2 * segment,
    counts.s3 * segment,
  ];
}

/** `grid-template-columns` for a level. Minisectors are `minmax(Npx, 1fr)` so
 *  width past level 0 spreads across them instead of gapping on the right. */
export function gridColumns(level: Density, counts: SectorCounts): string {
  const { driver, pit, tire } = DENSITY[level];
  const segment = segmentWidth(level);

  return [
    `${driver}px`,
    ...(pit ? [`${PIT_COLUMN}px`] : []),
    ...(tire ? [`${TIRE_COLUMN}px`] : []),
    `${GAP_COLUMN}px`,
    `${LAST_COLUMN}px`,
    `minmax(${counts.s1 * segment}px, 1fr)`,
    `minmax(${counts.s2 * segment}px, 1fr)`,
    `minmax(${counts.s3 * segment}px, 1fr)`,
  ].join(" ");
}

/** The width a level needs before anything would be clipped. */
export function tableWidth(level: Density, counts: SectorCounts): number {
  const widths = columnWidths(level, counts);
  const total = widths.reduce((sum, w) => sum + w, 0);
  return total + COLUMN_GAP * (widths.length - 1) + ROW_PADDING;
}

/** The richest level that fits in `width`. */
export function densityForWidth(width: number, counts: SectorCounts): Density {
  for (const level of DENSITY_LEVELS) {
    if (tableWidth(level, counts) <= width) return level;
  }
  return 4;
}

/** Level 4: every step on the ladder spent. The divider stops here. */
export function minTableWidth(counts: SectorCounts): number {
  return tableWidth(4, counts);
}

/** Level 0: nothing given up. Past this the minisector columns stretch. */
export function fullTableWidth(counts: SectorCounts): number {
  return tableWidth(0, counts);
}
