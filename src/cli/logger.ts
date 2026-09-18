export const log = {
  step(message: string): void {
    console.error(`[sdd-bot] ${message}`);
  },
  warn(message: string): void {
    console.error(`[sdd-bot] aviso: ${message}`);
  },
};
