import { sleep } from "../sources/x-rate";

/** Tests replace these so interval sleeps do not block and the slot clock stays honest. */
export const pacing = {
  now(): number {
    return Date.now();
  },
  sleep(ms: number): Promise<void> {
    return sleep(ms);
  },
};
