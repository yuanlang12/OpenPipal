const DESIGN_SYSTEM_STATIC_ORIGIN = 'http://127.0.0.1:3031'
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/

export async function getDesignSystemResourceBaseUrl(name: string): Promise<string> {
  const capability = await Promise.resolve((window.api as any)?.getDesignSystemResourceCapability?.(name))
  if (typeof capability !== 'string' || !CAPABILITY_PATTERN.test(capability)) {
    throw new Error('设计系统预览授权无效')
  }
  return `${DESIGN_SYSTEM_STATIC_ORIGIN}/design-systems/${capability}`
}

export function designSystemResourceUrl(baseUrl: string, name: string, rel: string): string {
  const encodedName = encodeURIComponent(name)
  const encodedRel = rel.split('/').map(part => encodeURIComponent(part)).join('/')
  return `${baseUrl}/${encodedName}/${encodedRel}`
}
