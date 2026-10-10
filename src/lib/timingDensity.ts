// How much the timing table gives up as it is narrowed, and how narrow it is
// allowed to get.
//
// The table is the constraint in the dashboard split: the map is an SVG with a
// viewBox, so it takes any size, while the table has five fixed columns and
// three minisector columns whose width is driven by the circuit's segment
// count. Dragging the divider is only useful if the table has a defined way to
// shed width, so it sheds it in this order:
//
//   1. the minisector bars get thinner
//   2. the driver column is compressed
//   3. the PIT column disappears
//   4. the tire column disappears
//
// Level 4 is the floor. The divider cannot go past it, so the table is never
// narrower than its own content — nothing is ever clipped or scrolled away by
// the drag itself.
//
// Both TimingBoard (the header) and DriverRow (every row) build their grid
// from here, so the two can never drift out of alignment.

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

/**
 * How wide a minisector bar may stretch when the table has room to spare.
 *
 * The sector columns are `1fr`, so a table wider than its level needs hands
 * them the surplus. Without a stretch the bars would stay their nominal width
 * and sit in the middle of an increasingly empty column. The cap keeps them
 * reading as a row of segments rather than a set of blocks.
 */
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

/**
 * `grid-template-columns` for a level.
 *
 * The minisector columns are `minmax(Npx, 1fr)` rather than a fixed width so
 * that widening the table past level 0 spreads the surplus across them instead
 * of leaving a gap on the right.
 */
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
