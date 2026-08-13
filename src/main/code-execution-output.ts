/** Format both process streams for the user while callers retain them separately in details. */
export function formatCodeExecutionOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) return `[stdout]\n${stdout}\n\n[stderr]\n${stderr}`
  return stdout || stderr || '(无输出)'
}
