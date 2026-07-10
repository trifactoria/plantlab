"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDateTime } from "@/lib/format";

type UploadResult = {
  filename: string;
  savedFilename?: string;
  photoId?: string;
  chosenTimestamp?: string;
  timestampSource?: string;
  success: boolean;
  error?: string;
};

export function PhotoUploadForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<UploadResult[]>([]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUploading(true);
    setError(null);
    setResults([]);

    const form = event.currentTarget;
    const input = form.elements.namedItem("files") as HTMLInputElement | null;
    const files = Array.from(input?.files ?? []);
    const formData = new FormData();

    for (const [index, file] of files.entries()) {
      formData.append("files", file);
      formData.append(`lastModified-${index}`, String(file.lastModified));
    }

    const response = await fetch(`/api/projects/${projectId}/photos/upload`, {
      method: "POST",
      body: formData,
    });
    const payload = (await response.json()) as {
      results?: UploadResult[];
      error?: string;
    };

    setUploading(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not upload photos.");
      return;
    }

    setResults(payload.results ?? []);
    form.reset();
    router.refresh();
  }

  return (
    <form onSubmit={upload} className="grid gap-3 rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-lg font-semibold text-stone-950">Upload Photos</h2>
        <p className="mt-1 text-sm text-stone-600">
          Import phone or manual photos into this project folder.
        </p>
      </div>

      <label className="field">
        Images
        <input
          className="input"
          name="files"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          required
        />
      </label>

      <button className="button w-fit" disabled={uploading}>
        {uploading ? "Uploading..." : "Upload Photos"}
      </button>

      {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}

      {results.length > 0 ? (
        <div className="grid gap-2 text-sm">
          {results.map((result) => (
            <div
              key={`${result.filename}-${result.savedFilename ?? result.error}`}
              className={`rounded-md border p-3 ${
                result.success
                  ? "border-emerald-200 bg-emerald-50 text-emerald-950"
                  : "border-red-200 bg-red-50 text-red-900"
              }`}
            >
              <p className="font-medium">{result.filename}</p>
              {result.success && result.chosenTimestamp ? (
                <p>
                  Imported at {formatDateTime(result.chosenTimestamp)} from {result.timestampSource}.
                  {result.photoId ? (
                    <>
                      {" "}
                      <Link className="font-semibold underline" href={`/photos/${result.photoId}`}>
                        Open photo
                      </Link>
                    </>
                  ) : null}
                </p>
              ) : (
                <p>{result.error ?? "Import failed."}</p>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </form>
  );
}
