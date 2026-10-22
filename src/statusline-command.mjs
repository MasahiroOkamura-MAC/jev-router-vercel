// Claude executes this setting as a shell command. Installation paths are data.
export function statuslineCommand(executable, script, platform = process.platform) {
  const paths = [executable, script];
  if (paths.some(path => /[\r\n\0]/.test(path))) return null;
  if (platform === "win32") {
    // Fail closed for cmd expansion/metacharacters; native Windows validation is
    // still required before claiming support for unusual installation paths.
    if (paths.some(path => /["%!&|<>^]/.test(path))) return null;
    return paths.map(path => `"${path}"`).join(" ");
  }
  return paths.map(path => `'${path.replaceAll("'", "'\"'\"'")}'`).join(" ");
}
