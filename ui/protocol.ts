export {};

declare module 'orca' {
  interface PluginRequests {
    'config.get': { input: Record<string, never>; output: { image: string } };
    'config.save': { input: { image: string }; output: { image: string } };
    'runtime.status': { input: Record<string, never>; output: { ready: boolean; detail: string } };
    'runtime.prepare': { input: Record<string, never>; output: { ready: boolean; detail: string } };
  }
}
