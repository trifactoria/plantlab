"use client";

import { KeyboardEvent, useState } from "react";

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** Tag chip editor. Serializes to/from the same comma-separated string the Plant.tags column stores. */
export function TagInput({
  label = "Tags",
  name,
  value,
  onChange,
  placeholder = "fast, control, tray-a",
}: {
  label?: string;
  name?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const tags = parseTags(value);

  function addDraft() {
    const next = draft.trim();
    setDraft("");
    if (!next || tags.some((tag) => tag.toLowerCase() === next.toLowerCase())) {
      return;
    }
    onChange([...tags, next].join(", "));
  }

  function removeTag(tag: string) {
    onChange(tags.filter((item) => item !== tag).join(", "));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addDraft();
    } else if (event.key === "Backspace" && draft === "" && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  }

  return (
    <label className="field">
      {label}
      <div className="input flex flex-wrap items-center gap-1.5 py-1.5">
        {name ? <input type="hidden" name={name} value={value} /> : null}
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-700"
          >
            {tag}
            <button
              type="button"
              className="text-stone-400 hover:text-stone-700"
              onClick={() => removeTag(tag)}
              aria-label={`Remove tag ${tag}`}
            >
              &times;
            </button>
          </span>
        ))}
        <input
          className="min-w-24 flex-1 border-none bg-transparent p-0 text-sm outline-none"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={addDraft}
          placeholder={tags.length === 0 ? placeholder : undefined}
        />
      </div>
    </label>
  );
}
