import { useState } from 'react';
import { workshopError } from './workshop-ui';

/** Mutation errors stay with the draft/form; successful server responses close it explicitly. */
export function useWorkshopTask() {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(action: () => Promise<void>, onSuccess?: () => void, message?: string) {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      onSuccess?.();
      if (message) setNotice(message);
      return true;
    } catch (cause) {
      setError(workshopError(cause));
      return false;
    } finally {
      setWorking(false);
    }
  }

  return { working, error, notice, run, clearError: () => setError(null) };
}
