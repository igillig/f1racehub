"use client";

import { WeatherData } from "@/types/f1";

function TemperatureGauge({
  value,
  label,
  min = 0,
  max = 60,
  unit = "°",
}: {
  value: number;
  label: string;
  min?: number;
  max?: number;
  unit?: string;
}) {
  const percentage = Math.min(Math.max((value - min) / (max - min), 0), 1);
  const angle = -135 + percentage * 270;
  const radius = 18;
  const cx = 25,
    cy = 25;
  const angleRad = (angle * Math.PI) / 180;
  const indicatorX = cx + radius * Math.cos(angleRad);
  const indicatorY = cy + radius * Math.sin(angleRad);
  const getColor = (pct: number) =>
    pct < 0.4 ? "#22c55e" : pct < 0.7 ? "#eab308" : "#ef4444";

  return (
    <div
      className="relative flex h-[58px] w-[58px] items-center justify-center"
      title={`${label}: ${value}${unit}`}
    >
      <svg className="absolute inset-0" viewBox="0 0 50 50">
        <defs>
          <linearGradient id={`tg-${label}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#22c55e" />
            <stop offset="50%" stopColor="#eab308" />
            <stop offset="100%" stopColor="#ef4444" />
          </linearGradient>
        </defs>
        <path
          d={`M ${cx + radius * Math.cos((-135 * Math.PI) / 180)} ${cy + radius * Math.sin((-135 * Math.PI) / 180)} A ${radius} ${radius} 0 1 1 ${cx + radius * Math.cos((135 * Math.PI) / 180)} ${cy + radius * Math.sin((135 * Math.PI) / 180)}`}
          fill="none"
          stroke="#27272a"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <path
          d={`M ${cx + radius * Math.cos((-135 * Math.PI) / 180)} ${cy + radius * Math.sin((-135 * Math.PI) / 180)} A ${radius} ${radius} 0 1 1 ${cx + radius * Math.cos((135 * Math.PI) / 180)} ${cy + radius * Math.sin((135 * Math.PI) / 180)}`}
          fill="none"
          stroke={`url(#tg-${label})`}
          strokeWidth="4"
          strokeLinecap="round"
          opacity="0.4"
        />
        <circle
          cx={indicatorX}
          cy={indicatorY}
          r="5"
          fill={getColor(percentage)}
          style={{ filter: `drop-shadow(0 0 4px ${getColor(percentage)})` }}
        />
      </svg>
      <div className="flex flex-col items-center z-10">
        <span className="text-sm font-bold text-white leading-none tabular-nums">
          {value}
          {unit}
        </span>
        <span
          className="text-[9px] font-medium leading-none uppercase"
          style={{ color: getColor(percentage) }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

function HumidityGauge({ value }: { value: number }) {
  const percentage = Math.min(value / 100, 1);
  const angle = -135 + percentage * 270;
  const radius = 18;
  const cx = 25,
    cy = 25;
  const angleRad = (angle * Math.PI) / 180;
  const indicatorX = cx + radius * Math.cos(angleRad);
  const indicatorY = cy + radius * Math.sin(angleRad);

  return (
    <div
      className="relative flex h-[58px] w-[58px] items-center justify-center"
      title={`Humidity: ${value}%`}
    >
      <svg className="absolute inset-0" viewBox="0 0 50 50">
        <path
          d={`M ${cx + radius * Math.cos((-135 * Math.PI) / 180)} ${cy + radius * Math.sin((-135 * Math.PI) / 180)} A ${radius} ${radius} 0 1 1 ${cx + radius * Math.cos((135 * Math.PI) / 180)} ${cy + radius * Math.sin((135 * Math.PI) / 180)}`}
          fill="none"
          stroke="#27272a"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <path
          d={`M ${cx + radius * Math.cos((-135 * Math.PI) / 180)} ${cy + radius * Math.sin((-135 * Math.PI) / 180)} A ${radius} ${radius} 0 1 1 ${cx + radius * Math.cos((135 * Math.PI) / 180)} ${cy + radius * Math.sin((135 * Math.PI) / 180)}`}
          fill="none"
          stroke="#3b82f6"
          strokeWidth="4"
          strokeLinecap="round"
          opacity="0.4"
        />
        <circle
          cx={indicatorX}
          cy={indicatorY}
          r="5"
          fill="#3b82f6"
          style={{ filter: "drop-shadow(0 0 4px #3b82f6)" }}
        />
      </svg>
      <div className="flex flex-col items-center z-10">
        <span className="text-sm font-bold text-white leading-none tabular-nums">
          {value}%
        </span>
        <span className="text-[9px] font-medium leading-none uppercase text-blue-500">
          HUM
        </span>
      </div>
    </div>
  );
}

export default function WeatherOverlay({ weather }: { weather: WeatherData }) {
  return (
    <div className="hidden sm:flex absolute top-2 left-2 z-10 gap-3">
      <TemperatureGauge
        value={Math.round(weather.trackTemp)}
        label="TRC"
        min={10}
        max={60}
      />
      <TemperatureGauge
        value={Math.round(weather.airTemp)}
        label="AIR"
        min={5}
        max={45}
      />
      <HumidityGauge value={Math.round(weather.humidity)} />
    </div>
  );
}
