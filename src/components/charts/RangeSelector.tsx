"use client";

import { HISTORY_RANGES, type HistoryRangeValue } from "@/lib/metricHistory";

export function RangeSelector({
  value,
  onChange,
  options = HISTORY_RANGES,
  label = "Range",
}: {
  value: HistoryRangeValue;
  onChange: (value: HistoryRangeValue) => void;
  options?: readonly { value: HistoryRangeValue; label: string }[];
  label?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${
            value === option.value ? "border-emerald-300 bg-emerald-100 text-emerald-900" : "border-stone-200 bg-white text-stone-600 hover:border-emerald-300"
          }`}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
