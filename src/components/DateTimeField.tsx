"use client";

export function DateTimeField({
  label,
  name,
  value,
  onChange,
  required = false,
}: {
  label: string;
  name?: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <label className="field">
      {label}
      <input
        className="input"
        name={name}
        type="datetime-local"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
      />
    </label>
  );
}
