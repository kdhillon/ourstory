import { useState, useEffect, useRef, useCallback } from 'react';
import { YEAR_MIN, YEAR_MAX } from '../types';

// ─── Date encoding ────────────────────────────────────────────────────────────
//
// Timeline position is an integer in "offset-YYYYMMDD" format:
//   encodeDate(year, month, day) = (year + YEAR_OFFSET) * 10000 + month * 100 + day
//
// Examples:
//   Sep 11, 2001 → (2001 + 10000) * 10000 + 0911 = 120010911
//   480 BCE Jan 1 → (−480 + 10000) * 10000 + 0101 = 95200101
//
// The +10000 offset keeps all years in range [−9999, 89999] positive, so
// betweenness checks are plain integer comparisons with no floating-point risk.

export const YEAR_OFFSET = 10000;
export const STEP_DAY    = 1;
export const STEP_MONTH  = 100;
export const STEP_YEAR   = 10000;

const STEP_OPTIONS = [
  STEP_DAY,
  STEP_MONTH,
  STEP_YEAR,
  STEP_YEAR * 5,
  STEP_YEAR * 10,
  STEP_YEAR * 25,
  STEP_YEAR * 50,
  STEP_YEAR * 100,
  STEP_YEAR * 250,
];

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeap(year)) return 29;
  return DAYS[month] ?? 30;
}

export function encodeDate(year: number, month = 1, day = 1): number {
  return (year + YEAR_OFFSET) * 10000 + month * 100 + day;
}

export function decodeDate(dateInt: number): { year: number; month: number; day: number } {
  const shifted = Math.floor(dateInt / 10000);
  const year    = shifted - YEAR_OFFSET;
  const rest    = dateInt - shifted * 10000;
  const month   = Math.floor(rest / 100);
  const day     = rest % 100;
  return { year, month, day };
}

/** Fix invalid month/day values that can result from raw integer addition/subtraction. */
export function normalizeDateInt(raw: number): number {
  let { year, month, day } = decodeDate(raw);

  // Normalize month into [1, 12]
  if (month < 1 || month > 12) {
    const total = year * 12 + (month - 1);
    year  = Math.floor(total / 12);
    month = ((total % 12) + 12) % 12 + 1;
  }

  // Normalize day into [1, daysInMonth(year, month)]
  const maxDay = daysInMonth(year, month);
  if (day < 1) {
    month -= 1;
    if (month < 1) { month = 12; year -= 1; }
    day = daysInMonth(year, month) + day; // day was ≤ 0, add to prev month
    if (day < 1) day = 1;
  } else if (day > maxDay) {
    day -= maxDay;
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    if (day < 1) day = 1;
  }

  return encodeDate(year, month, day);
}

export const DATE_MIN = encodeDate(YEAR_MIN, 1, 1);
export const DATE_MAX = encodeDate(YEAR_MAX, 12, 31);

/** Compute [startDateInt, endDateInt] for an event given its year/month/day fields.
 *  endDateInt is the last dateInt when the event is "active" (before the fade window). */
export function eventDateRange(
  yearStart: number,
  monthStart: number | null | undefined,
  dayStart:   number | null | undefined,
  yearEnd:    number | null | undefined,
  monthEnd:   number | null | undefined,
  dayEnd:     number | null | undefined,
): [number, number] {
  const startInt = encodeDate(yearStart, monthStart ?? 1, dayStart ?? 1);

  let endInt: number;
  if (yearEnd != null) {
    // Multi-year event: end = last moment of the end year/month/day
    endInt = encodeDate(yearEnd, monthEnd ?? 12, dayEnd ?? 31);
  } else if (monthStart != null) {
    endInt = dayStart != null
      ? startInt                                    // exact day: visible on that day
      : encodeDate(yearStart, monthStart, 31);      // month-only: visible all month (day 31 ≥ any month end)
  } else {
    endInt = encodeDate(yearStart, 12, 31);         // year-only: visible all year
  }

  return [startInt, endInt];
}

export function displayDate(dateInt: number, stepSize = STEP_YEAR): string {
  const { year, month, day } = decodeDate(dateInt);
  const yr = year === 0 ? 'Year 0' : year < 0 ? `${Math.abs(year)} BCE` : `${year}`;

  if (stepSize >= STEP_YEAR)  return yr;

  const mName = MONTH_NAMES[Math.max(0, month - 1)];
  if (stepSize >= STEP_MONTH) return `${mName} ${yr}`;

  return `${day} ${mName} ${yr}`;
}

// Keep legacy name for callers that haven't been updated yet
export const displayYear = displayDate;

export function useTimeline() {
  const [currentDateInt, setCurrentDateInt] = useState(() => encodeDate(1790, 1, 1));
  const [stepSize,        setStepSize]      = useState(STEP_MONTH);
  const [isPlaying,       setIsPlaying]     = useState(false);
  const [playbackSpeed,   setPlaybackSpeed] = useState(1); // steps per second
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const seek = useCallback((dateInt: number) => {
    setCurrentDateInt(
      Math.max(DATE_MIN, Math.min(DATE_MAX, normalizeDateInt(Math.round(dateInt)))),
    );
  }, []);

  const step = useCallback((direction: 1 | -1) => {
    setCurrentDateInt((cur) => {
      const raw = cur + direction * stepSize;
      return Math.max(DATE_MIN, Math.min(DATE_MAX, normalizeDateInt(raw)));
    });
  }, [stepSize]);

  const togglePlay = useCallback(() => setIsPlaying((p) => !p), []);

  // Playback: advance at `playbackSpeed` steps/second.
  // e.g. 1× with month step = 1 month/sec; 5× with year step = 5 years/sec.
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (isPlaying) {
      const advancePerTick = stepSize;
      const msPerTick = 1000 / playbackSpeed;
      intervalRef.current = setInterval(() => {
        setCurrentDateInt((cur) => {
          const next = normalizeDateInt(cur + advancePerTick);
          if (next > DATE_MAX) { setIsPlaying(false); return DATE_MAX; }
          return next;
        });
      }, msPerTick);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [isPlaying, stepSize, playbackSpeed]);

  // Keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el  = e.target as HTMLElement;
      const tag  = el?.tagName;
      const type = (el as HTMLInputElement)?.type;

      if (e.key === ' ') {
        // Space toggles play from anywhere except real text inputs/textareas.
        // Selects and range sliders get blurred first so focus returns to the document.
        if (tag === 'TEXTAREA') return;
        if (tag === 'INPUT' && type !== 'range') return;
        e.preventDefault();
        el?.blur();
        togglePlay();
        return;
      }

      // All other shortcuts: skip when a form element has focus
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') return; // handled by InfoPanel in App
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft')  step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, togglePlay]);

  return {
    currentDateInt,
    stepSize,
    isPlaying,
    playbackSpeed,
    stepOptions: STEP_OPTIONS,
    seek,
    step,
    togglePlay,
    setStepSize,
    setPlaybackSpeed,
  };
}
