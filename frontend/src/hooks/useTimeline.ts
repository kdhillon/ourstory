import { useState, useEffect, useRef, useCallback } from 'react';
import { YEAR_MIN, YEAR_MAX } from '../types';

const STEP_OPTIONS = [1, 5, 10, 25, 50, 100, 250];

export function useTimeline() {
  const [currentYear, setCurrentYear] = useState(YEAR_MIN);
  const [stepSize, setStepSize] = useState(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(10); // years per second
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const seek = useCallback((year: number) => {
    setCurrentYear(Math.max(YEAR_MIN, Math.min(YEAR_MAX, year)));
  }, []);

  const step = useCallback((direction: 1 | -1) => {
    setCurrentYear((y) => {
      const next = y + direction * stepSize;
      return Math.max(YEAR_MIN, Math.min(YEAR_MAX, next));
    });
  }, [stepSize]);

  const play = useCallback(() => setIsPlaying(true), []);
  const pause = useCallback(() => setIsPlaying(false), []);
  const togglePlay = useCallback(() => setIsPlaying((p) => !p), []);

  // Playback interval
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);

    if (isPlaying) {
      const msPerStep = (1000 / playbackSpeed) * stepSize;
      intervalRef.current = setInterval(() => {
        setCurrentYear((y) => {
          const next = y + stepSize;
          if (next > YEAR_MAX) {
            setIsPlaying(false);
            return YEAR_MAX;
          }
          return next;
        });
      }, msPerStep);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying, stepSize, playbackSpeed]);

  // Keyboard arrow key navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, togglePlay]);

  return {
    currentYear,
    stepSize,
    isPlaying,
    playbackSpeed,
    stepOptions: STEP_OPTIONS,
    seek,
    step,
    play,
    pause,
    togglePlay,
    setStepSize,
    setPlaybackSpeed,
  };
}

export function displayYear(year: number): string {
  if (year === 0) return 'Year 0';
  if (year < 0) return `${Math.abs(year)} BCE`;
  return `${year} CE`;
}
