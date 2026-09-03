import type { RuntimeState } from '../types/runtime';
import { shutdownInput } from '../input/cleanup';
import { terminateOcr } from '../perception/ocr';
import { terminateOpenCv } from '../perception/opencv';
import { closeTerminalWorker } from '../services/terminalWorkerClient';

export const shutdownRuntime = async (state: RuntimeState) => {
  if (state.closing) return;
  state.closing = true;
  const failures: unknown[] = [];
  if (state.stateSweepTimer) clearInterval(state.stateSweepTimer);
  if (state.control.leaseTimer) clearTimeout(state.control.leaseTimer);
  if (state.control.cleanupRetryTimer) clearTimeout(state.control.cleanupRetryTimer);
  try { await shutdownInput(state); } catch (error) { failures.push(error); }
  const workers = await Promise.allSettled([terminateOcr(), terminateOpenCv()]);
  for (const result of workers) if (result.status === 'rejected') failures.push(result.reason);
  for (const session of state.terminals.values()) {
    try { await session.close(); } catch (error) { failures.push(error); }
  }
  state.terminals.clear();
  try { await closeTerminalWorker(state); } catch (error) { failures.push(error); }
  state.preparedPointers.clear();
  state.observations.clear();
  state.screenshots.clear();
  state.resources.clear();
  if (failures.length) throw new AggregateError(failures, 'Computer-use runtime shutdown did not complete cleanly.');
};
