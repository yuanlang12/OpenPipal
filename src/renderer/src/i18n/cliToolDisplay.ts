export interface CliToolDisplaySource {
  name: string
  command: string
  description: string
  builtIn: boolean
}

interface CliToolTranslationKeys {
  name: string
  description: string
}

/**
 * The main-process CLI registry is also used as Agent runtime input, so its
 * protocol values stay untouched. Only known built-in commands receive
 * localized product copy at the renderer boundary.
 */
export const BUILT_IN_CLI_TRANSLATION_KEYS: Readonly<Record<string, CliToolTranslationKeys>> = {
  gh: { name: 'toolsHub.cli.builtIns.gh.name', description: 'toolsHub.cli.builtIns.gh.description' },
  node: { name: 'toolsHub.cli.builtIns.node.name', description: 'toolsHub.cli.builtIns.node.description' },
  npm: { name: 'toolsHub.cli.builtIns.npm.name', description: 'toolsHub.cli.builtIns.npm.description' },
  pnpm: { name: 'toolsHub.cli.builtIns.pnpm.name', description: 'toolsHub.cli.builtIns.pnpm.description' },
  bun: { name: 'toolsHub.cli.builtIns.bun.name', description: 'toolsHub.cli.builtIns.bun.description' },
  python3: { name: 'toolsHub.cli.builtIns.python3.name', description: 'toolsHub.cli.builtIns.python3.description' },
  pip3: { name: 'toolsHub.cli.builtIns.pip3.name', description: 'toolsHub.cli.builtIns.pip3.description' },
  git: { name: 'toolsHub.cli.builtIns.git.name', description: 'toolsHub.cli.builtIns.git.description' },
  docker: { name: 'toolsHub.cli.builtIns.docker.name', description: 'toolsHub.cli.builtIns.docker.description' },
  'lark-cli': { name: 'toolsHub.cli.builtIns.larkCli.name', description: 'toolsHub.cli.builtIns.larkCli.description' },
  dingtalk: { name: 'toolsHub.cli.builtIns.dingtalk.name', description: 'toolsHub.cli.builtIns.dingtalk.description' },
  vercel: { name: 'toolsHub.cli.builtIns.vercel.name', description: 'toolsHub.cli.builtIns.vercel.description' },
  netlify: { name: 'toolsHub.cli.builtIns.netlify.name', description: 'toolsHub.cli.builtIns.netlify.description' },
  aws: { name: 'toolsHub.cli.builtIns.aws.name', description: 'toolsHub.cli.builtIns.aws.description' },
  gcloud: { name: 'toolsHub.cli.builtIns.gcloud.name', description: 'toolsHub.cli.builtIns.gcloud.description' },
  az: { name: 'toolsHub.cli.builtIns.az.name', description: 'toolsHub.cli.builtIns.az.description' },
  supabase: { name: 'toolsHub.cli.builtIns.supabase.name', description: 'toolsHub.cli.builtIns.supabase.description' },
  wrangler: { name: 'toolsHub.cli.builtIns.wrangler.name', description: 'toolsHub.cli.builtIns.wrangler.description' },
  curl: { name: 'toolsHub.cli.builtIns.curl.name', description: 'toolsHub.cli.builtIns.curl.description' },
  jq: { name: 'toolsHub.cli.builtIns.jq.name', description: 'toolsHub.cli.builtIns.jq.description' },
  ffmpeg: { name: 'toolsHub.cli.builtIns.ffmpeg.name', description: 'toolsHub.cli.builtIns.ffmpeg.description' },
  convert: { name: 'toolsHub.cli.builtIns.convert.name', description: 'toolsHub.cli.builtIns.convert.description' },
  ollama: { name: 'toolsHub.cli.builtIns.ollama.name', description: 'toolsHub.cli.builtIns.ollama.description' },
}

export function resolveCliToolDisplay(
  tool: CliToolDisplaySource,
  translate: (key: string) => string
): Pick<CliToolDisplaySource, 'name' | 'description'> {
  if (!tool.builtIn) return { name: tool.name, description: tool.description }
  const keys = BUILT_IN_CLI_TRANSLATION_KEYS[tool.command]
  if (!keys) return { name: tool.name, description: tool.description }
  return { name: translate(keys.name), description: translate(keys.description) }
}
