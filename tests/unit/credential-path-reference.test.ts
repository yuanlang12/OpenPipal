/**
 * 凭据路径的文本闸（只在没有 OS 沙箱的平台上启用，见 pi-security 的 bash / execute_code 分支）。
 *
 * 判据是"token 里有没有**路径形状**的凭据位置"，不是整串子串匹配：
 * `process.env.X` 里的 `.env` 不是路径；项目根下的 `.npmrc` 是仓库配置不是家目录凭据。
 * 反斜杠先折成正斜杠，所以 bash 与 PowerShell 两种写法共用一张表。
 */
import { describe, expect, it } from 'vitest'
import { detectCredentialPathReference } from '../../src/main/pi-security'

describe('detectCredentialPathReference：应拦', () => {
  it.each([
    'cat ~/.ssh/id_rsa',
    'cat $HOME/.aws/credentials',
    'type C:\\Users\\alice\\.aws\\credentials',
    'Get-Content $env:USERPROFILE\\.ssh\\id_ed25519',
    'cat ~/.npmrc',
    'cat $HOME/.git-credentials',
    'type %USERPROFILE%\\.netrc',
    'cat /Users/alice/.config/gh/hosts.yml',
    'Get-Content "$env:APPDATA\\GitHub CLI\\hosts.yml"',
    'Get-Content $env:APPDATA\\gcloud\\credentials.db',
    'Get-Content $env:APPDATA\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt',
    'cat ~/.zsh_history | grep token',
    'cat .env',
    'cat ./config/.env.local',
    'type %USERPROFILE%\\.openpipal\\config.json',
    'cat ~/.openpipal/oauth/github.json',
    'ls ~/.openpipal/tasks',
    'Get-Content C:\\Users\\alice\\.openpipal\\git-policy.json',
    `python -c "open('/Users/alice/.config/gh/hosts.yml').read()"`,
    "import os\nopen(os.path.expanduser('~/.aws/credentials'))"
  ])('%s', (text) => {
    expect(detectCredentialPathReference(text)).toBeTruthy()
  })
})

describe('detectCredentialPathReference：不应误伤', () => {
  it.each([
    'node -e "console.log(process.env.HOME)"',
    'cat .env.example',
    'cp .env.sample .env.example',
    'cat .envrc',
    'cat .npmrc',                         // 项目根下的仓库配置，不是家目录凭据
    'git config credential.helper store',
    'curl https://sts.amazonaws.com',
    'echo $AWS_REGION',
    'ls ~/.openpipal/workspace',
    'git clone --depth 1 https://github.com/x/y ~/.openpipal/skills/y',
    'grep -r TODO src',
    'npm run build',
    'Get-ChildItem -Recurse src',
    'pip install ssh-audit',
    'docker compose up',
    'kubectl get pods'
  ])('%s', (text) => {
    expect(detectCredentialPathReference(text)).toBeNull()
  })

  it('空文本返回 null', () => {
    expect(detectCredentialPathReference('')).toBeNull()
  })
})
