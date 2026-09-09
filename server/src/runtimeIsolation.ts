/** npm propagates its lifecycle name into child processes; direct test-file execution is recognized too.
 * A test-started server or subsystem must explicitly choose a throwaway DATA_DIR before it may write
 * durable runtime state. */
export function testInvocationUsesDefaultData(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): boolean {
  const testLifecycle = /^test(?::|$)/i.test(env.npm_lifecycle_event?.trim() ?? "");
  const directTestFile = argv.some((part) =>
    /(?:^|[\\/])src[\\/]tests[\\/]|(?:^|[\\/])[^\\/]+\.(?:i?test)\.(?:[cm]?[jt]sx?)$/i.test(part),
  );
  return (testLifecycle || directTestFile) && !env.DATA_DIR?.trim();
}
