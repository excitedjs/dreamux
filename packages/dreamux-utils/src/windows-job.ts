import koffi, { type KoffiFunc } from 'koffi';
import { promisify } from 'node:util';
import { withWindowsOwnerOnlySecurityDescriptor } from './windows-security.js';

// Anonymous ABI descriptions keep this native owner independent of other DLL users.
const basicLimits = koffi.struct({
  PerProcessUserTimeLimit: 'int64_t',
  PerJobUserTimeLimit: 'int64_t',
  LimitFlags: 'uint32_t',
  MinimumWorkingSetSize: 'size_t',
  MaximumWorkingSetSize: 'size_t',
  ActiveProcessLimit: 'uint32_t',
  Affinity: 'uintptr_t',
  PriorityClass: 'uint32_t',
  SchedulingClass: 'uint32_t',
});
const extendedLimits = koffi.struct({
  BasicLimitInformation: basicLimits,
  IoInfo: koffi.array('uint64_t', 6),
  ProcessMemoryLimit: 'size_t',
  JobMemoryLimit: 'size_t',
  PeakProcessMemoryUsed: 'size_t',
  PeakJobMemoryUsed: 'size_t',
});
const securityAttributes = koffi.struct({
  nLength: 'uint32_t',
  lpSecurityDescriptor: 'void *',
  bInheritHandle: 'int',
});

function loadApi() {
  const kernel = koffi.load('kernel32.dll');
  const createJob = kernel.func('__stdcall', 'CreateJobObjectW', 'void *', [
    koffi.pointer(securityAttributes),
    'str16',
  ]) as KoffiFunc<(security: object, name: string | null) => bigint | null>;
  const openJob = kernel.func(
    'void * __stdcall OpenJobObjectW(uint32_t, int, const char16_t *)',
  ) as KoffiFunc<
    (access: number, inherit: number, name: string) => bigint | null
  >;
  const currentProcess = kernel.func(
    'void * __stdcall GetCurrentProcess()',
  ) as KoffiFunc<() => bigint>;
  const setInformation = kernel.func(
    '__stdcall',
    'SetInformationJobObject',
    'int',
    ['void *', 'int', koffi.pointer(extendedLimits), 'uint32_t'],
  ) as KoffiFunc<
    (job: bigint, kind: number, limits: object, size: number) => number
  >;
  const openProcess = kernel.func(
    'void * __stdcall OpenProcess(uint32_t, int, uint32_t)',
  ) as KoffiFunc<
    (access: number, inherit: number, pid: number) => bigint | null
  >;
  const assignProcess = kernel.func(
    'int __stdcall AssignProcessToJobObject(void *, void *)',
  ) as KoffiFunc<(job: bigint, process: bigint) => number>;
  const terminateJob = kernel.func(
    'int __stdcall TerminateJobObject(void *, uint32_t)',
  ) as KoffiFunc<(job: bigint, code: number) => number>;
  const queryInformation = kernel.func(
    'int __stdcall QueryInformationJobObject(void *, int, void *, uint32_t, void *)',
  ) as KoffiFunc<
    (
      job: bigint,
      kind: number,
      info: Buffer,
      size: number,
      returned: null,
    ) => number
  >;
  const isProcessInJob = kernel.func(
    'int __stdcall IsProcessInJob(void *, void *, _Out_ int *)',
  ) as KoffiFunc<(process: bigint, job: bigint, member: number[]) => number>;
  const wait = kernel.func(
    'uint32_t __stdcall WaitForSingleObject(void *, uint32_t)',
  ) as KoffiFunc<(process: bigint, timeout: number) => number>;
  const closeHandle = kernel.func(
    'int __stdcall CloseHandle(void *)',
  ) as KoffiFunc<(handle: bigint) => number>;
  const lastError = kernel.func(
    'uint32_t __stdcall GetLastError()',
  ) as KoffiFunc<() => number>;
  return {
    createJob,
    openJob,
    currentProcess,
    setInformation,
    openProcess,
    assignProcess,
    terminateJob,
    queryInformation,
    isProcessInJob,
    wait,
    closeHandle,
    lastError,
  };
}

let api: ReturnType<typeof loadApi> | undefined;
function native() {
  return (api ??= loadApi());
}

function checked(
  result: number | bigint | null,
  operation: string,
  code?: number,
): void {
  if (!result)
    throw new Error(
      `${operation} failed${code === undefined ? '' : ` (Windows error ${code})`}`,
    );
}

/** Launch-owned Windows process tree. No operation resolves an unowned PID. */
export class WindowsJob {
  private root: bigint | null = null;

  private constructor(private job: bigint | null) {}

  static async create(name?: string): Promise<WindowsJob> {
    return WindowsJob.createHandle(name, false);
  }

  /** Hold a service's existing Job, or reserve its name before startup can launch work. */
  static async acquire(name: string): Promise<WindowsJob> {
    return WindowsJob.createHandle(name, true);
  }

  private static async createHandle(
    name: string | undefined,
    acceptExisting: boolean,
  ): Promise<WindowsJob> {
    return withWindowsOwnerOnlySecurityDescriptor(async (descriptor) => {
      const handle = native().createJob(
        {
          nLength: koffi.sizeof(securityAttributes),
          lpSecurityDescriptor: descriptor,
          bInheritHandle: 0,
        },
        name ?? null,
      );
      // Non-waiting handle acquisition keeps GetLastError on the same thread.
      // Assignment, mutation, queries and waiting use async native calls.
      const code = native().lastError();
      const existed = code === 183;
      checked(handle, 'CreateJobObjectW', code);
      if (name !== undefined && existed) {
        // Opening an existing Job must not alter its limits or security.
        if (acceptExisting) return new WindowsJob(handle);
        native().closeHandle(handle!);
        throw new Error(`Windows Job already exists: ${name}`);
      }
      const job = new WindowsJob(handle);
      try {
        checked(
          await promisify(native().setInformation.async)(
            handle!,
            9,
            { BasicLimitInformation: { LimitFlags: 0x2000 } },
            koffi.sizeof(extendedLimits),
          ),
          'SetInformationJobObject',
        );
      } catch (error) {
        job.close();
        throw error;
      }
      return job;
    });
  }

  static async open(name: string): Promise<WindowsJob | null> {
    const handle = native().openJob(0x0002 | 0x0004 | 0x0008, 0, name);
    const code = native().lastError();
    if (handle === null && code === 2) return null;
    checked(handle, 'OpenJobObjectW', code);
    return new WindowsJob(handle);
  }

  /** Service entrypoints call this before launching any application work. */
  async assignCurrentProcess(): Promise<void> {
    if (this.job === null) throw new Error('Windows Job is closed');
    checked(
      await promisify(native().assignProcess.async)(
        this.job,
        native().currentProcess(),
      ),
      'AssignProcessToJobObject',
    );
  }

  /** Test membership against this exact Job, without resolving a process ID. */
  async containsCurrentProcess(): Promise<boolean> {
    if (this.job === null) throw new Error('Windows Job is closed');
    const member = [0];
    checked(
      await promisify(native().isProcessInJob.async)(
        native().currentProcess(),
        this.job,
        member,
      ),
      'IsProcessInJob',
    );
    return member[0] !== 0;
  }

  /** Hold the candidate object; the caller must prove identity over its child IPC before assign(). */
  async openRoot(pid: number): Promise<void> {
    this.root = await promisify(native().openProcess.async)(
      0x0100 | 0x0001 | 0x1000 | 0x00100000,
      0,
      pid,
    );
    checked(this.root, 'OpenProcess');
  }

  async assign(): Promise<void> {
    if (this.job === null || this.root === null)
      throw new Error('Windows Job has no held root');
    checked(
      await promisify(native().assignProcess.async)(this.job, this.root),
      'AssignProcessToJobObject',
    );
  }

  async terminate(): Promise<void> {
    if (this.job === null) return;
    // Prevent new members before capturing wait handles. TerminateJobObject
    // clears the active count/list before those processes have actually exited.
    checked(
      await promisify(native().setInformation.async)(
        this.job,
        9,
        {
          BasicLimitInformation: { LimitFlags: 0x2008, ActiveProcessLimit: 0 },
        },
        koffi.sizeof(extendedLimits),
      ),
      'SetInformationJobObject',
    );
    const members: bigint[] = [];
    try {
      const rootMember = [0];
      if (this.root !== null) {
        checked(
          await promisify(native().isProcessInJob.async)(
            this.root,
            this.job,
            rootMember,
          ),
          'IsProcessInJob',
        );
      }
      for (const pid of await this.memberIds()) {
        const handle = await promisify(native().openProcess.async)(
          0x00100000 | 0x1000,
          0,
          pid,
        );
        if (handle === null) {
          // A process can finish naturally between the Job query and OpenProcess.
          if ((await this.memberIds()).includes(pid))
            throw new Error(
              'OpenProcess could not retain a Windows Job member',
            );
          continue;
        }
        const member = [0];
        try {
          checked(
            await promisify(native().isProcessInJob.async)(
              handle,
              this.job,
              member,
            ),
            'IsProcessInJob',
          );
          if (member[0] !== 0) members.push(handle);
          else native().closeHandle(handle);
        } catch (error) {
          native().closeHandle(handle);
          throw error;
        }
      }
      checked(
        await promisify(native().terminateJob.async)(this.job, 1),
        'TerminateJobObject',
      );
      // Failed bootstrap identity/assignment leaves only a candidate handle;
      // it is never authority to wait on an unrelated reused PID generation.
      const waits =
        this.root !== null && rootMember[0] !== 0
          ? [...members, this.root]
          : members;
      await Promise.all(
        waits.map(async (handle) => {
          const result = await promisify(native().wait.async)(
            handle,
            0xffffffff,
          );
          if (result !== 0)
            throw new Error(`WaitForSingleObject failed (${result})`);
        }),
      );
    } finally {
      for (const handle of members) native().closeHandle(handle);
    }
  }

  private async memberIds(): Promise<number[]> {
    if (this.job === null) return [];
    const pointerSize = koffi.sizeof('uintptr_t');
    let buffer = Buffer.alloc(8 + pointerSize);
    for (;;) {
      const result = await promisify(native().queryInformation.async)(
        this.job,
        3,
        buffer,
        buffer.length,
        null,
      );
      const assigned = buffer.readUInt32LE(0);
      const listed = buffer.readUInt32LE(4);
      if (assigned > listed) {
        buffer = Buffer.alloc(8 + assigned * pointerSize);
        continue;
      }
      checked(result, 'QueryInformationJobObject');
      return Array.from({ length: listed }, (_, index) =>
        pointerSize === 8
          ? Number(buffer.readBigUInt64LE(8 + index * pointerSize))
          : buffer.readUInt32LE(8 + index * pointerSize),
      );
    }
  }

  close(): void {
    if (this.root !== null) native().closeHandle(this.root);
    if (this.job !== null) native().closeHandle(this.job);
    this.root = null;
    this.job = null;
  }
}
