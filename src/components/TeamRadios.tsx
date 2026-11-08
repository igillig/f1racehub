"use client";

import { RadioCapture, Driver } from "@/types/f1";
import { TEAM_COLORS } from "@/lib/constants";
import { useState, useRef, useEffect } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { radioTurns } from "@/lib/radioText";
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
  const { t, language } = useLanguage();
  // Keyed by clip URL, not list index: a new radio landing during playback
  // shifts every index down and the highlight used to jump to another clip.
  const [playingPath, setPlayingPath] = useState<string | null>(null);
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
    setPlayingPath(null);
    setIsLoading(false);
    setIsActuallyPlaying(false);
    setProgress(0);
  };

  const handlePlay = async (path: string) => {
    const audio = audioRef.current;
    if (!audio) return;

    // Clicking the clip that's already playing stops it
    if (playingPath === path) {
      audio.pause();
      resetPlayback();
      return;
    }

    setIsLoading(true);
    setIsActuallyPlaying(false);
    setPlayingPath(path);
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
            const isPlaying = playingPath === radio.path;
            const turns = radioTurns(radio, language);
            // Only a clip that just arrived can still be with the
            // transcriber; an old one without text is one that has none.
            const awaitingTranscript =
              turns.length === 0 &&
              Date.now() - new Date(radio.utc).getTime() < 120_000;

            return (
              <div
                key={`${radio.path}-${index}`}
                className={`flex items-start gap-3 px-3 py-2 border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors cursor-pointer ${
                  isPlaying ? "bg-zinc-800/50" : ""
                }`}
                onClick={() => handlePlay(radio.path)}
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
                <div className="shrink-0 mt-0.5">
                  <DriverTag
                    code={driverInfo.code}
                    team={driverInfo.team}
                    size="sm"
                    showLogo={false}
                  />
                </div>

                {/* Transcript + playback progress */}
                <div className="flex-1 min-w-0 flex flex-col gap-1 py-0.5">
                  {turns.length > 0 ? (
                    <div className="flex flex-col gap-0.5">
                      {turns.map((turn, i) => (
                        <p
                          key={i}
                          className="text-[11px] leading-snug text-zinc-300 line-clamp-2"
                          title={turn.text}
                        >
                          {/* Only a clip with two voices carries roles, and
                              then the tag is what makes it readable: the
                              driver speaks as themselves, the pit wall as
                              "ING". */}
                          {turn.speaker !== "unknown" && (
                            <span
                              className="mr-1 font-medium"
                              style={{
                                color:
                                  turn.speaker === "driver"
                                    ? teamColor
                                    : "#a1a1aa",
                              }}
                            >
                              {turn.speaker === "driver"
                                ? driverInfo.code
                                : t("teamRadios.engineer")}
                            </span>
                          )}
                          {turn.text}
                        </p>
                      ))}
                    </div>
                  ) : (
                    // No caption yet: the clip is still with the transcriber,
                    // or transcription is off. Either way the row keeps the
                    // waveform it has always had.
                    <div className="flex items-center gap-2">
                      <AudioWaveform
                        color={teamColor}
                        isAnimating={isPlaying && isActuallyPlaying}
                      />
                      {awaitingTranscript && (
                        <span className="text-[10px] text-zinc-600 italic truncate">
                          {t("teamRadios.transcribing")}
                        </span>
                      )}
                    </div>
                  )}

                  <div className="h-1.5 bg-zinc-700/50 rounded-full overflow-hidden">
                    {isPlaying && isLoading ? (
                      <div
                        className="h-full w-full rounded-full animate-pulse"
                        style={{ backgroundColor: `${teamColor}40` }}
                      />
                    ) : (
                      <div
                        className="h-full rounded-full transition-all duration-100"
                        style={{
                          width: isPlaying ? `${progress}%` : "0%",
                          backgroundColor: teamColor,
                        }}
                      />
                    )}
                  </div>
                </div>

                {/* Time ago */}
                <span className="text-[10px] text-zinc-500 tabular-nums flex-shrink-0 mt-1">
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
