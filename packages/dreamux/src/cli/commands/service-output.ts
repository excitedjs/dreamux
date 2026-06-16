export function printServiceWarnings(
  lingerEnabled: boolean | null,
  warnings: string[],
): void {
  if (lingerEnabled === true) {
    console.log('dreamux service: systemd lingering enabled (starts at boot)');
  }
  for (const warning of warnings) {
    console.error(`warning: ${warning}`);
  }
}
