export const BOOTSTRAP_GUIDE = [
  '# Dreamux bootstrap: profile files missing',
  '',
  'This Dispatcher keeps two profile files in `.workspace/` under its working directory:',
  '',
  '- `.workspace/identity.md`: who you are when you work for this user: the name you go by, your role, your voice and working style.',
  '- `.workspace/user.md`: who the user is: how to address them, what they work on, their preferences and standing instructions.',
  '',
  'At least one of them is missing. Early in the conversation, at a natural point, tell the user and offer to create the missing ones together. Ask a few short questions, draft each missing file, show the draft, and write it only after the user confirms. Keep both files short, in plain Markdown.',
  '',
  'Once both files exist, TeamLeaders started from then on receive them at launch, and this Dispatcher receives them the next time it starts. This guide, `.workspace/bootstrap.md`, is then removed automatically; do not edit or delete it yourself.',
].join('\n');

export function renderProfile(
  dir: string,
  profile: { identity: string; user: string },
): string {
  return [
    '# Profile',
    '',
    `These files come from ${dir}. \`identity.md\` describes who you are; \`user.md\` describes the user you work for.`,
    '',
    '## identity.md',
    '',
    profile.identity.trim(),
    '',
    '## user.md',
    '',
    profile.user.trim(),
  ].join('\n');
}
