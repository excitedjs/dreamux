import type { TeammateOps } from '../teammate-collection/types.js';

export function admittedTeammateOps(input: {
  teammates: TeammateOps;
  admit: <T>(task: () => Promise<T>) => Promise<T>;
}): TeammateOps {
  const { teammates, admit } = input;
  return {
    spawn: async (spawnInput) => admit(() => teammates.spawn(spawnInput)),
    send: async (sendInput) => admit(() => teammates.send(sendInput)),
    close: async (closeInput) => admit(() => teammates.close(closeInput)),
    list: () => teammates.list(),
    status: (name) => teammates.status(name),
    history: (historyInput) => teammates.history(historyInput),
    last: (name, query) => teammates.last(name, query),
    getCapabilities: () => teammates.getCapabilities(),
  };
}
