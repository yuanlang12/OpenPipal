import type { TFunction } from 'i18next'

export function buildInterpretTranscriptArchive(
  messages: Array<{ role: string; content: string }>,
  t: TFunction
): { title: string; content: string } {
  const lines = messages.map((message) =>
    `**${message.role === 'user' ? t('chat.voiceArchive.source') : t('chat.voiceArchive.translation')}** ${message.content.trim()}`
  )
  return {
    title: t('chat.voiceArchive.title'),
    content: `# ${t('chat.voiceArchive.heading')}\n\n${lines.join('\n\n')}\n`
  }
}
