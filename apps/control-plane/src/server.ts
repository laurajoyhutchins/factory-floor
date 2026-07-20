import { startProductionControlPlane } from './production-process.js';

try {
  await startProductionControlPlane({
    onShutdownError: (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
