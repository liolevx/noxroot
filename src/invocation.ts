export const VERSION = "0.1.2";

export const CLI_INVOCATION = `npx --yes noxroot@${VERSION}`;

export function cliCommand(command: string): string {
  return `${CLI_INVOCATION} ${command}`;
}
