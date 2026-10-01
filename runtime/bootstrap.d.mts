// Types for runtime/bootstrap.mjs (the file itself stays dependency-free JavaScript,
// because the kit commits it verbatim into customer repos).
export const BOOTSTRAP_VERSION: string;

export interface BootstrapOptions {
  command: string;
  args?: string[];
  trustPath: string;
  runtimeOrigin?: string;
  apiOrigin?: string;
  env?: Record<string, string | undefined>;
}

export function bootstrap(options: BootstrapOptions): Promise<number>;
