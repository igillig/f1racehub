"use client";

import { RadioCapture, Driver } from "@/types/f1";
import { TEAM_COLORS } from "@/lib/constants";
import { useState, useRef, useEffect } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import DriverTag from "./DriverTag";

interface TeamRadiosProps {
  radios: RadioCapture[];
  drivers: Driver[];
}

function formatTimeAgo(utc: string): string {
  const now = new Date();
  const time = new Date(utc);
  const diffMs = now.getTime() - time.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return `${Math.floor(diffSec / 3600)}h ago`;
}

// Audio frequency bars component
function AudioWaveform({
  color,
  isAnimating,
}: {
  color: string;
  isAnimating: boolean;
}) {
  return (
    <div className="flex items-center gap-[2px] h-4">
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className="w-[3px] rounded-full transition-all"
          style={{
            backgroundColor: color,
            height: isAnimating ? undefined : "4px",
            animation: isAnimating
              ? `audioWave 0.5s ease-in-out infinite`
              : "none",
            animationDelay: isAnimating ? `${i * 0.1}s` : "0s",
          }}
        />
      ))}
      <style jsx>{`
        @keyframes audioWave {
          0%,
          100% {
            height: 4px;
          }
          50% {
            height: 16px;
          }
        }
      `}</style>
    </div>
  );
}

// Play/Stop button icons
function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}

function LoadingIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="animate-spin"
    >
      <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
    </svg>
  );
}

export default function TeamRadios({ radios, drivers }: TeamRadiosProps) {
  const { t } = useLanguage();
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isActuallyPlaying, setIsActuallyPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Clean up audio on unmount
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  const resetPlayback = () => {
    setPlayingIndex(null);
    setIsLoading(false);
    setIsActuallyPlaying(false);
    setProgress(0);
  };

  const handlePlay = async (index: number, path: string) => {
    const audio = audioRef.current;
    if (!audio) return;

    // Clicking the clip that's already playing stops it
    if (playingIndex === index) {
      audio.pause();
      resetPlayback();
      return;
    }

    setIsLoading(true);
    setIsActuallyPlaying(false);
    setPlayingIndex(index);
    setProgress(0);

    try {
      audio.src = path;
      audio.load();
      await audio.play();
    } catch (error) {
      console.error("Error playing audio:", error);
      resetPlayback();
    }
  };

  const getDriverInfo = (racingNumber: string) => {
    const driver = drivers.find((d) => d.driverNumber === racingNumber);
    if (!driver) return { code: racingNumber, team: "Unknown" };
    return { code: driver.code, team: driver.team };
  };

  return (
    <div className="h-full flex flex-col">
      {/* Persistent, DOM-attached audio element. iOS Safari is unreliable when
          playing detached `new Audio()` instances, so the clip is played through
          this element instead. */}
      <audio
        ref={audioRef}
        preload="auto"
        onPlaying={() => {
          setIsLoading(false);
          setIsActuallyPlaying(true);
        }}
        onEnded={resetPlayback}
        onError={() => {
          console.error("Error loading audio");
          resetPlayback();
        }}
        onTimeUpdate={() => {
          const audio = audioRef.current;
          if (audio && audio.duration) {
            setProgress((audio.currentTime / audio.duration) * 100);
          }
        }}
      />

      {/* Radio list */}
      <div className="flex-1 overflow-y-auto">
        {radios.length > 0 ? (
          radios.map((radio, index) => {
            const driverInfo = getDriverInfo(radio.racingNumber);
            const teamColor = TEAM_COLORS[driverInfo.team] || "#888";
            const isPlaying = playingIndex === index;

            return (
              <div
                key={`${radio.path}-${index}`}
                className={`flex items-center gap-3 px-3 py-2 border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors cursor-pointer ${
                  isPlaying ? "bg-zinc-800/50" : ""
                }`}
                onClick={() => handlePlay(index, radio.path)}
              >
                {/* Play/Stop button - cleaner design */}
                <button
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-all flex-shrink-0 border-2 ${
                    isPlaying
                      ? "border-white/20 bg-white/10 text-white"
                      : "border-zinc-600 bg-zinc-800 text-zinc-400 hover:border-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {isPlaying && isLoading ? (
                    <LoadingIcon />
                  ) : isPlaying ? (
                    <StopIcon />
                  ) : (
                    <PlayIcon />
                  )}
                </button>

                {/* Driver info */}
                <DriverTag
                  code={driverInfo.code}
                  team={driverInfo.team}
                  size="sm"
                  showLogo={false}
                />

                {/* Progress bar with waveform effect */}
                <div className="flex-1 flex items-center gap-2 min-w-0">
                  {isPlaying && isActuallyPlaying ? (
                    <>
                      {/* Waveform animation */}
                      <AudioWaveform color={teamColor} isAnimating={true} />
                      {/* Progress bar */}
                      <div className="flex-1 h-1.5 bg-zinc-700/50 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-100"
                          style={{
                            width: `${progress}%`,
                            backgroundColor: teamColor,
                          }}
                        />
                      </div>
                    </>
                  ) : isPlaying && isLoading ? (
                    <>
                      {/* Loading state with pulsing waveform */}
                      <AudioWaveform color={teamColor} isAnimating={true} />
                      <div className="flex-1 h-1.5 bg-zinc-700/50 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full animate-pulse"
                          style={{
                            width: "100%",
                            backgroundColor: `${teamColor}40`,
                          }}
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Static waveform */}
                      <AudioWaveform color={teamColor} isAnimating={false} />
                      {/* Empty progress bar */}
                      <div className="flex-1 h-1.5 bg-zinc-700/50 rounded-full overflow-hidden">
                        <div className="h-full w-0" />
                      </div>
                    </>
                  )}
                </div>

                {/* Time ago */}
                <span className="text-[10px] text-zinc-500 tabular-nums flex-shrink-0">
                  {formatTimeAgo(radio.utc)}
                </span>
              </div>
            );
          })
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
            {t("teamRadios.noRadios")}
          </div>
        )}
      </div>
    </div>
  );
}
