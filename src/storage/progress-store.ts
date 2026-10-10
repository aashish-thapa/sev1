import { emptyProgress, ProgressSchema, type Progress } from "../domain/progress.ts";

export interface ProgressStore {
  load(): Progress;
  save(progress: Progress): void;
}

const STORAGE_KEY = "sev1.progress.v1";

/**
 * Browser storage can be missing or throw (private mode, blocked site data),
 * so every access degrades to an in-memory session instead of crashing.
 */
export class BrowserProgressStore implements ProgressStore {
  private readonly storage: Storage | undefined;
  private fallback: Progress = emptyProgress();

  constructor(storage: Storage | undefined) {
    this.storage = storage;
  }

  load(): Progress {
    const raw = this.read();
    if (raw === null) return this.fallback;
    try {
      const parsed = ProgressSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : emptyProgress();
    } catch (error) {
      if (error instanceof SyntaxError) return emptyProgress();
      throw error;
    }
  }

  save(progress: Progress): void {
    this.fallback = progress;
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(progress));
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      // Quota or access denied: the in-memory copy keeps this session playable.
    }
  }

  private read(): string | null {
    try {
      return this.storage?.getItem(STORAGE_KEY) ?? null;
    } catch (error) {
      if (error instanceof DOMException) return null;
      throw error;
    }
  }
}

export class MemoryProgressStore implements ProgressStore {
  private progress: Progress;

  constructor(initial: Progress = emptyProgress()) {
    this.progress = initial;
  }

  load(): Progress {
    return this.progress;
  }

  save(progress: Progress): void {
    this.progress = progress;
  }
}
