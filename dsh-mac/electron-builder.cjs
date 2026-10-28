/** Unsigned Apple Silicon zip. The MIT notice is copied into the app bundle. */
module.exports = {
  appId: 'site.demox.botcamp.dsh-desktop',
  productName: 'DSH Desktop',
  copyright: 'Copyright (c) 2026 Anywhere Labs',
  mac: {
    target: [{ target: 'zip', arch: ['arm64'] }],
    category: 'public.app-category.productivity',
    identity: null,
    notarize: false,
    gatekeeperAssess: false,
    hardenedRuntime: false,
  },
  files: ['dist/**/*', 'LICENSE'],
  extraResources: [{ from: 'LICENSE', to: 'LICENSE' }],
  directories: { output: 'release' },
}
